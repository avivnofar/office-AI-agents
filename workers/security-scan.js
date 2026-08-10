/**
 * workers/security-scan.js — THE PRE-PUBLICATION SECURITY SCAN (policy A10).
 *
 * Built 2026-08-10, wiring OFFICE-POLICY.md A10 ("The public repo") into the one
 * place a public write happens. Until this file existed, A10's last paragraph —
 *
 *   > **A mandatory automated check before publication** scans for security
 *   > terms. **Automatic, never judgment** — an agent weighing whether something
 *   > is sensitive will eventually be wrong, and in a public repo once is enough.
 *
 * — was a sentence in a document nothing read. This module is the check.
 *
 * ── WHAT A10 ACTUALLY ASKS FOR, AND WHAT IT DOES NOT ─────────────────────
 *
 * A10 draws a line that is easy to misread in the direction of blocking
 * everything:
 *
 *   REFUSED   — a security FINDING. Open, closed or historical, all three named
 *               explicitly. "A closed finding still tells an attacker where to
 *               look, how the defence is built, and that the area is worth
 *               probing."
 *   PERMITTED — that the office PERFORMS security review. "The role and the
 *               process, never a finding or a mechanism."
 *
 * So the vocabulary below is FINDING-SHAPED, not topic-shaped. "The Cyber Expert
 * reviewed the configuration" publishes. "The review found an unauthenticated
 * endpoint" does not. A scanner keyed on the word *security* would refuse the
 * office's own org chart, and a scanner that refuses everything gets switched
 * off within a week — which is the same outcome as never having built it, minus
 * the reassurance.
 *
 * ── REFUSE, NEVER WARN ───────────────────────────────────────────────────
 *
 * A10 is explicit that this is automatic and not judgment. `scanOutbound()`
 * therefore returns a verdict, and `commitFileToRepo()` in workers/repo-write.js
 * turns a dirty verdict into a REFUSED WRITE — not a logged warning, not a
 * commit with a note attached. The content stays where it was written (the back
 * office), which is exactly where A10 says findings live.
 *
 * ── THE FALSE-POSITIVE QUESTION WAS MEASURED, NOT ASSUMED ────────────────
 *
 * The hazard of an automatic refusal on a live cron is obvious: a term list
 * tuned by taste silently stops the daily report, and "no report today" looks
 * identical to "quiet day". So `scripts/verify-security-scan.js` runs this
 * scanner over THE ENTIRE ALREADY-PUBLISHED CORPUS of this repo and reports
 * every hit. That number is the honest cost of the list, it is printed rather
 * than asserted away, and a hit on already-published content is itself an A10
 * finding rather than a bug in the scanner.
 *
 * ── WHY `guides/` IS OUT OF SCOPE, AND IT IS NOT AN EXEMPTION ────────────
 *
 * `guides/cybersecurity/` and `guides/firewall/` are EDUCATIONAL CONTENT about
 * security in general — the office's product, not a report on the office's own
 * defences. A10 governs what the office says ABOUT ITSELF; it does not forbid
 * the office from having a security practice area. Those files already pass
 * through two gates this one does not duplicate: guide-engine.js's ABSOLUTE ZERO
 * blocklist and the Architect's full review. Scoping is in SCANNED_PREFIXES
 * below, as data, so widening it is a one-line change with a visible diff.
 */

/**
 * FINDING-SHAPED VOCABULARY.
 *
 * Every entry has to answer one question: *could this phrase appear in a
 * sentence that is not a security finding about this office?* Where the answer
 * was yes, the phrase was narrowed until it was no — which is why several
 * entries are two words rather than one ("security finding", not "security";
 * "leaked credential", not "credential").
 *
 * `label` is what the refusal says. It goes into a log the owner reads, so it
 * names the RULE, not the regex.
 */
export const SECURITY_TERMS = Object.freeze([
  { id: 'cve', label: 'a CVE identifier', re: /\bCVE-\d{4}-\d{3,}\b/i },
  // NOT bare "vulnerability" — that word is a DISCIPLINE NAME as often as it is
  // a claim, and the discipline names are topics the office is allowed to work
  // on and publish about. Measured: the bare form refused 6 already-published
  // files, 5 of them for the phrases below. The negative lookahead is a
  // structural exclusion (a fixed list of nouns), not a judgment call about
  // whether a given sentence "feels" sensitive — A10 forbids the latter.
  { id: 'vulnerability', label: 'a vulnerability claim', re: /\bvulnerabilit(?:y|ies)\b(?!\s+(?:management|disclosure|assessment|scanning|scanner|research|databases?|classes?))|\bvulnerable to\b/i },
  { id: 'exploit', label: 'an exploit or exploitability claim', re: /\bexploit(?:ed|able|ation)?\b/i },
  { id: 'security-finding', label: 'a security finding, by name', re: /\bsecurity (?:finding|finding s|issue|flaw|defect|hole|gap|incident)\b/i },
  { id: 'unauthenticated', label: 'an unauthenticated access path', re: /\bunauthenticated\b|\bno auth(?:entication)? required\b/i },
  { id: 'privilege-escalation', label: 'a privilege-escalation path', re: /\bprivilege escalation\b|\bescalate privileges\b/i },
  { id: 'attacker', label: 'an attacker or attack-surface description', re: /\battacker\b|\battack surface\b|\battack vector\b/i },
  // Both word orders. "the exposed token" and "the token was exposed" are the
  // same disclosure, and a list that catches one of them is a list that reads
  // as covering the case while covering half of it.
  { id: 'leaked-secret', label: 'a leaked or exposed secret', re: /\b(?:leaked|exposed|exposure of|compromised) (?:key|keys|token|tokens|secret|secrets|credential|credentials|password|passwords)\b|\b(?:key|keys|token|tokens|secret|secrets|credential|credentials|password|passwords)\b[^.\n]{0,24}\b(?:was|were|is|are|got|had been)\s+(?:leaked|exposed|compromised)\b|\b(?:key|token|credential|secret) (?:leak|exposure|compromise)\b/i },
  { id: 'hardcoded-secret', label: 'a hardcoded secret', re: /\bhard-?coded (?:key|token|secret|password|credential)s?\b/i },
  { id: 'rce', label: 'remote code execution', re: /\bremote code execution\b|\bRCE\b/ },
  { id: 'zero-day', label: 'a zero-day', re: /\bzero-?day\b|\b0-day\b/i },
  { id: 'injection', label: 'an injection attack', re: /\b(?:prompt|SQL|command|shell) injection\b/i },
  { id: 'bypass', label: 'a described way past a control', re: /\bbypass(?:es|ed|ing)? the (?:guard|gate|check|deny-?list|permission|auth|token)\w*/i },
  { id: 'open-to-the-internet', label: 'an exposed endpoint description', re: /\bpublicly (?:reachable|writable|exposed)\b|\bopen to the internet\b/i },
]);

/**
 * WHICH PUBLIC PATHS ARE SCANNED.
 *
 * A prefix list rather than a "scan everything except" list, deliberately: a new
 * directory added to the public repo is UNSCANNED until someone decides it
 * should be, and that decision leaves a diff. The inverse — scan everything,
 * exempt by exception — makes the exceptions the interesting file and the
 * additions invisible.
 *
 * `reports/` is the whole point: daily, weekly, meeting transcripts and gap
 * digests are what the office actually publishes about itself.
 */
export const SCANNED_PREFIXES = Object.freeze([
  'reports/',
  'agent-output/',
  'docs/',
  'README',
  'PROJECT-CONTEXT-SUMMARY',
  'AGENTS.md',
]);

/** True when a path in the PUBLIC repo is subject to A10's scan. */
export function isScannedPath(path) {
  const p = String(path || '');
  return SCANNED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Removes the parts of a markdown line that are IDENTIFIERS rather than PROSE:
 * inline code spans, markdown link targets, and bare URLs.
 *
 * ── WHY, AND WHY IT IS NOT A LOOPHOLE ────────────────────────────────────
 *
 * `reports/daily/day-041-summary.md` names a guide slug —
 * `explaining-the-practical-steps-of-a-vulnerability-disclosure` — inside
 * backticks and again inside a link target. That is a FILENAME. Refusing the
 * office's daily report because a file it links to has a security word in its
 * name would stop the daily report every time the Guides pipeline touched the
 * cybersecurity domain, which is by design roughly weekly.
 *
 * The reason this is safe: A10 exists to stop a security FINDING being
 * published, and a finding is a sentence, not a path. Prose survives this strip
 * untouched — `reports/notebook-x/housekeeping/2026-07-15.md`'s real
 * path-traversal finding is still caught, because it is written in English
 * outside every code span. Measured both ways in §6 of the verifier.
 *
 * Fenced code blocks are NOT handled here (this is line-at-a-time); they are
 * handled in scanOutbound(), which tracks fence state as it walks.
 */
export function stripNonProse(line) {
  return String(line)
    .replace(/`[^`]*`/g, ' ')          // inline code — filenames, ids, commands
    .replace(/\]\([^)]*\)/g, '] ')     // markdown link TARGETS (the label stays: it is prose)
    .replace(/https?:\/\/\S+/g, ' ');  // bare URLs
}

/**
 * Scans outbound public content.
 *
 * PURE — no env, no I/O, no config import — so scripts/verify-security-scan.js
 * can run it over the entire published corpus under plain `node` and produce a
 * real number rather than a claim. Same reason task-router.js imports no JSON.
 *
 * @param {string} text
 * @param {{path?: string, max?: number}} [opts]
 * @returns {{clean: boolean, hits: Array<{id,label,line,excerpt}>, scanned: boolean}}
 */
export function scanOutbound(text, opts = {}) {
  const path = opts.path ?? null;
  // A path that is not in scope is reported as NOT SCANNED, never as CLEAN.
  // "We checked it and it was fine" and "we did not check it" are different
  // facts, and collapsing them is how a scanner comes to cover less than its
  // callers believe.
  if (path !== null && !isScannedPath(path)) {
    return { clean: true, scanned: false, hits: [] };
  }

  const lines = String(text || '').split('\n');
  const hits = [];
  const max = opts.max ?? 25;
  // Fenced code blocks are stripped WHOLESALE for the same reason inline code
  // is: a config excerpt or a command is an identifier, not a claim about the
  // office. A finding written only inside a fence is a finding nobody stated.
  let inFence = false;
  for (let i = 0; i < lines.length && hits.length < max; i += 1) {
    if (/^\s*(?:```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const prose = stripNonProse(lines[i]);
    for (const term of SECURITY_TERMS) {
      const m = term.re.exec(prose);
      if (!m) continue;
      hits.push({
        id: term.id,
        label: term.label,
        line: i + 1,
        // A short excerpt, never the whole line: this string ends up in a log
        // and in a trigger response, and a refusal that reprints the sensitive
        // sentence in full has published it into a different place instead.
        excerpt: `…${prose.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).trim()}…`,
      });
      break; // one hit per line is enough to refuse; listing every term on one line is noise
    }
  }

  return { clean: hits.length === 0, scanned: true, hits };
}

/** The refusal line. One place, so the log, the verifier and the trigger agree. */
export function renderScanRefusal(path, hits) {
  return `A10 pre-publication scan REFUSED ${path}: ${hits.length} security term(s) — `
    + hits.slice(0, 5).map((h) => `line ${h.line} ${h.label}`).join('; ')
    + (hits.length > 5 ? `; +${hits.length - 5} more` : '')
    + '. Security findings are never published — open, closed or historical. This content belongs in back-office-AI-agents.';
}
