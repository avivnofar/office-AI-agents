/**
 * workers/office-policy.js — THE POLICY, MADE LOAD-BEARING.
 *
 * Built 2026-08-10. `back-office-AI-agents/docs/OFFICE-POLICY.md` was approved
 * by the owner that morning and NOTHING READ IT. That is the eleventh instance
 * of this project's dominant defect — a mechanism that exists with no calling
 * path reaching it — and this time it landed on the policy itself, which means
 * every rule in it was held up by whatever the code happened to enforce and
 * nothing else.
 *
 * ── ONE SOURCE, TWO READERS ──────────────────────────────────────────────
 *
 * The policy's own header states its architecture: *"Both the office's agents
 * and the headless midnight run read it. Not two synchronised copies — one
 * source, two readers."* This module is reader one. Reader two is the midnight
 * run, which is pointed at the same file by
 * back-office `campus/agents/10-the-architect/automation/instructions_architect.txt`
 * §0.5 — a POINTER, not a copy, for the reason A9 gives: *copies diverge, and
 * this project already has a document two edits behind its counterpart.*
 *
 * ── WHY A DIGEST AND NOT THE DOCUMENT ────────────────────────────────────
 *
 * The document is ~14,000 characters. office-context.js's whole agent budget is
 * 400 tokens and it is spent on EVERY model call, of which the office makes
 * many a day. Injecting the policy verbatim would cost roughly 4,700 tokens per
 * call — twelve times the entire existing office-context allowance, to restate
 * rules that mostly govern meetings the agent is not in.
 *
 * So `POLICY_DIGEST` below is a compact OPERATIVE summary: the five rules that
 * change what an agent does at the moment it is about to act. It is a
 * transcription, not a paraphrase-with-latitude, and the drift risk is handled
 * the way this repo handles every other two-things-that-must-agree:
 * `scripts/verify-office-policy.js` reads the REAL policy file from the sibling
 * checkout and asserts that every id in the digest is a real heading, that the
 * re-check date in code matches the file's, and that the ⚖️-marked provisional
 * rules in code are exactly the ⚖️-marked rules in the file. A digest that
 * drifts is a failing check, not a quiet lie.
 *
 * ── WHAT WAS CUT, AND IN WHAT ORDER ──────────────────────────────────────
 *
 * Cut FIRST and entirely: A3 (the improvement loop's probation numbers), A4
 * (delivery-lifecycle composition), A5, A6, A9, A10, A12, A13, A14, A16, and
 * all of Part B. Every one of those governs a MECHANISM that already has its
 * own code — the lifecycle module, the report pipeline, the security scan, the
 * meeting engine — and an agent cannot act on them at the moment of a single
 * model call. They are enforced where they live; restating them in every prompt
 * would cost tokens to tell an agent about a meeting it is not attending.
 *
 * ── CORRECTION, 2026-08-11 (appended, not edited in place — A15) ─────────
 *
 * "A3... already has its own code" was FALSE the day this file was written.
 * This module and A3's actual mechanism (`workers/probation.js`,
 * `probation-review.js`, `context-editor.js`) were both built 2026-08-10, but
 * this file landed EARLIER that day than "Wire the Learning Loop" — the
 * session that gave A3 its code. At the moment this sentence was first
 * committed, A3 governed nothing but the policy document itself; it became
 * true only once that later session shipped, still the same calendar day.
 * The instance report a reader loads today is accurate BY COINCIDENCE of
 * timing, not because the claim was checked against the code that existed
 * when it was written. Documentation-asserted-capability, the same shape
 * `docs/CAPABILITY-TOOLBOX.md` names for the Designer and gate-call-audit —
 * flagged rather than silently reconciled, per this project's own standing
 * rule. No functional change: A3 is still cut from the digest, correctly,
 * because it does have its own code now.
 *
 * Cut SECOND, from the brief shape only: A8's objection procedure and A2's
 * governing principle. Kept in the full shape (meetings and reports) because a
 * meeting is exactly where an objection is raised.
 *
 * NEVER cut, at any shape: A1. The red line is the one rule whose violation
 * cannot be undone by a later review, and it is one sentence.
 *
 * ── ⚖️ IS NOT DECORATION ──────────────────────────────────────────────────
 *
 * The policy marks several rules ⚖️ — *reasoned rather than measured*, revisit
 * 2026-08-24. `PROVISIONAL_RULES` carries those ids and the digest says so out
 * loud. A rule quietly promoted from provisional to settled by being restated
 * without its marker is how a reasoned guess becomes a fact nobody can trace,
 * and this project has a section in its own CLAUDE.md about exactly that.
 */

export const POLICY_REPO = 'back-office-AI-agents';
export const POLICY_PATH = 'docs/OFFICE-POLICY.md';

/**
 * The re-check date and the provisional rule ids, TRANSCRIBED from the policy.
 *
 * These are the two facts the digest asserts about the document rather than
 * about the office, so they are the two most likely to go stale silently. The
 * verifier pins both against the real file.
 */
export const POLICY_RECHECK_DATE = '2026-08-24';
export const POLICY_APPROVED_DATE = '2026-08-10';
export const PROVISIONAL_RULES = Object.freeze(['A2', 'A5']);

/**
 * THE OPERATIVE DIGEST.
 *
 * `brief` is what a single agent sees on every model call. `full` is what a
 * meeting and a report see, where the extra tokens are affordable (a meeting
 * pays once; the report shapes make no model call at all).
 *
 * Wording rule followed throughout: every line is an IMPERATIVE the reader can
 * act on, not a description of a rule that exists. "No agent modifies the code
 * that runs it" beats "A1 governs code modification".
 */
export const POLICY_DIGEST = Object.freeze([
  {
    id: 'A1',
    title: 'The red line',
    brief: 'A1 RED LINE: no agent modifies the code that runs it — Worker, permission guard, router, its own client module. Never.',
    full: 'A1 THE RED LINE: no agent modifies the code that runs it — not the Worker, not the permission guard, not the router, not its own client module. Never, under any circumstance. AI checking AI is better than nothing and is NOT enough; the policy, the tests and the owner\'s approval stand in for the gap.',
  },
  {
    id: 'A2',
    title: 'What may change, and who may change it',
    brief: 'A2 WHO CHANGES WHAT: code — nobody. The character bible — the owner. Your own active context — not you; the QA and Team Lead change OTHER agents\'. Adaptations — append only, never delete.',
    full: 'A2 WHO CHANGES WHAT: code — nobody, ever. The character bible — the owner alone, after the full process. Active context (what feeds the prompt) — the QA and the Team Lead, for OTHER agents only; no agent modifies its own. Adaptations — the agent itself and reviewers, APPEND ONLY, never deletion. ⚖️ The governing principle is provisional: the earlier and wider a change\'s effect, the fewer hands may touch it.',
  },
  {
    id: 'A7',
    title: 'Where agents may write',
    brief: 'A7 WRITE: warehouse — all, documented. Back office — text only, no code. Public repo — content and docs, never Worker code. Live projects — branch only, on owner instruction, never merge. aviv-brain — never. ONE ACTIVE BRANCH PER PROJECT: continue the one you find; opening a second while one is active is forbidden.',
    full: 'A7 WHERE YOU MAY WRITE: warehouse — everything including push, with full documentation of what was done and why. Back office — text, reports, documents, character files; NO code. Public repo — content, documentation, README, and moving files to the back office; never the Worker code. Live projects — a branch only, on explicit owner instruction, never a merge. aviv-brain — never. THE BRANCH RULE: one active branch per project. A run that finds an active branch continues on it; creating a new branch while one is active is forbidden; a new branch is permitted only after the previous is merged or explicitly abandoned by the owner. Merging is the Architect\'s act, on the owner\'s specific authorization.',
  },
  {
    id: 'A8',
    title: 'Escalation to the owner',
    brief: 'A8 ESCALATION: the owner gets finished work, not questions. A question never stalls you — do everything it does not block, keep surfacing it until answered, and record what you will do on silence.',
    full: 'A8 ESCALATION: the owner receives finished work, not questions — do everything you can first, then submit a result with a recommendation. A question is never a stall: continue with everything not blocked by the answer, keep surfacing it until answered, and record what you will do if no answer comes. Only admins may object to a task, after a meeting and real investigation, with reasoning and an alternative — an objection may delay work, it may not freeze it. The office may propose policy amendments; only the owner decides.',
  },
  {
    id: 'A15',
    title: 'Corrections and mistakes',
    brief: 'A15 CORRECTIONS: wrong yesterday? fix it, then report — not silence, not stopping without trying. Corrections to published work are appended and dated, never silent. Nothing is ever deleted.',
    full: 'A15 CORRECTIONS: an agent that finds it was wrong yesterday tries to fix it, then reports — not silence, and not stopping without trying. Corrections to published work are appended and dated; NEVER a silent edit, because a number that changes without explanation makes every other number unverifiable. Nothing is ever deleted — not adaptations, not findings, not history.',
  },
]);

/** Rule ids that must survive every shape and every budget. See the header. */
export const NEVER_CUT = Object.freeze(['A1']);

/* ─────────────────────────────── Parsing ──────────────────────────────── */

/**
 * Parses OFFICE-POLICY.md.
 *
 * Same posture as office-context.js's parsers, for the same stated reason:
 * REFUSE, do not guess. A policy file whose headings cannot be read is reported
 * as an error and reaches no prompt — because a half-parsed policy that renders
 * as three rules would be indistinguishable from an office with three rules.
 *
 * @returns {{ok: true, rules, partB, recheck, provisional, malformed} | {ok: false, reason: string}}
 */
export function parsePolicy(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return { ok: false, reason: 'policy markdown was empty or not a string' };
  }

  const headingRe = /^## ((?:A|B|C)\d+)\. (.+)$/gm;
  const rules = [];
  let m;
  while ((m = headingRe.exec(markdown)) !== null) {
    const end = headingRe.lastIndex;
    // `^#{1,2} ` and not `^## `. With the narrower anchor, B5's body ran on past
    // `# PART C` and swallowed Part C's own ⚖️ line, so B5 was reported
    // provisional when the marker belonged to the part heading after it. Caught
    // by the first live read against the real file — a rule wrongly flagged
    // provisional is a rule an agent is entitled to treat as unsettled.
    const nextIdx = markdown.slice(end).search(/^#{1,2} /m);
    const body = nextIdx === -1 ? markdown.slice(end) : markdown.slice(end, end + nextIdx);
    rules.push({
      id: m[1],
      title: m[2].trim(),
      part: m[1][0],
      // The ⚖️ marker means "reasoned, not measured — revisit". Read from the
      // BODY rather than assumed from a code list, so a rule the owner promotes
      // or demotes moves here without anyone remembering to edit this file.
      provisional: body.includes('⚖️'),
    });
  }

  if (!rules.length) {
    return { ok: false, reason: 'no "## A1. Title"-shaped rule headings found — OFFICE-POLICY.md format changed, or this is not the policy' };
  }

  const malformed = [];
  const recheckMatch = /Re-check date:\s*\*{0,2}(\d{4}-\d{2}-\d{2})/.exec(markdown)
    || /Re-check\s+(\d{4}-\d{2}-\d{2})/.exec(markdown);
  const recheck = recheckMatch ? recheckMatch[1] : null;
  if (!recheck) {
    // Reported, never defaulted. The re-check date is the only thing that stops
    // a provisional rule becoming permanent by inertia; a null that renders as
    // nothing is how it would.
    malformed.push('re-check date not found — expected "Re-check date: YYYY-MM-DD". Provisional rules have no expiry until this parses.');
  }

  // The digest claims five rule ids exist. If the document no longer has one of
  // them, the digest is quoting a rule that was renumbered or removed, and that
  // is a REFUSAL rather than a note: an agent told "A7 says X" about a document
  // with no A7 has been given a fabricated citation.
  const ids = new Set(rules.map((r) => r.id));
  const missing = POLICY_DIGEST.map((d) => d.id).filter((id) => !ids.has(id));
  if (missing.length) {
    return { ok: false, reason: `the digest cites ${missing.join(', ')} and the policy has no such rule — OFFICE-POLICY.md was renumbered and workers/office-policy.js POLICY_DIGEST is now quoting rules that do not exist` };
  }

  return {
    ok: true,
    rules,
    partB: rules.filter((r) => r.part === 'B'),
    recheck,
    provisional: rules.filter((r) => r.provisional).map((r) => r.id),
    malformed,
  };
}

/* ────────────────────────────── Rendering ─────────────────────────────── */

/**
 * Builds the policy block.
 *
 * @param {'brief'|'full'} shape
 * @param {{parsed?: object}} [opts]  the parsed live policy, when available;
 *        the digest renders WITHOUT it (see below) but says less.
 * @returns {{text: string, tokens: number, shape: string}}
 */
export function buildPolicyBlock(shape = 'brief', opts = {}) {
  const parsed = opts.parsed || null;
  const key = shape === 'full' ? 'full' : 'brief';

  /*
   * THE DIGEST RENDERS EVEN WHEN THE FILE COULD NOT BE FETCHED, and that is the
   * one place this module deliberately differs from office-context.js.
   *
   * office-context.js renders NOTHING when the board is unreadable, correctly:
   * an invented board is worse than no board. But the policy's operative rules
   * are constraints, and a constraint that disappears when a GitHub read fails
   * is a constraint that a network blip removes. A1 must be in the prompt on the
   * office's worst day, not only its best. So the digest is code, the live file
   * is corroboration, and the header line says which of the two the reader got.
   */
  const provisional = parsed?.provisional?.length ? parsed.provisional : PROVISIONAL_RULES;
  const recheck = parsed?.recheck || POLICY_RECHECK_DATE;

  /*
   * THE HEADER IS SHAPE-SPECIFIC TOO, and that was measured rather than
   * assumed. The one header served both shapes at 110 tokens, which on the
   * `brief` shape was a fifth of the whole policy block spent restating the
   * policy's provenance to an agent about to answer one question. The full
   * shape keeps it: a meeting IS the place where "who may amend this" matters.
   */
  const header = key === 'full'
    ? `OFFICE POLICY — owner-approved ${POLICY_APPROVED_DATE}, AUTHORITATIVE and binding on every agent, every session and the midnight run.`
      + ` This is the operative summary; the full text is ${POLICY_REPO} ${POLICY_PATH} and it is the authority where this summary is thinner.`
      + ` The owner is its only editor — you may PROPOSE a change (A8) and you may not make one.`
      + ` Rules marked ⚖️ (${provisional.join(', ')}) were reasoned rather than measured and are revisited ${recheck}; do not treat them as settled.`
      + (parsed ? '' : ' [live policy file not read this cycle — the rules below are the office\'s own transcription and still bind]')
    : `OFFICE POLICY (binding; full text ${POLICY_REPO} ${POLICY_PATH} — the authority. Owner is its only editor: propose, never change. ⚖️${provisional.join(',')} provisional, re-check ${recheck}).`
      + (parsed ? '' : ' [live file unread this cycle; these rules still bind]');

  const body = POLICY_DIGEST.map((d) => d[key]).join('\n');
  const text = `${header}\n${body}`;
  return { text, tokens: Math.ceil(text.length / 3), shape: key };
}

/**
 * The one-line pointer for anything that must NAME the policy without carrying
 * it — the midnight run's session record, a report footer, a board note.
 */
export function policyPointer() {
  return `${POLICY_REPO} ${POLICY_PATH} (owner-approved ${POLICY_APPROVED_DATE}, owner is the only editor, re-check ${POLICY_RECHECK_DATE})`;
}
