#!/usr/bin/env node
/**
 * scripts/verify-denylist.js — the night run's deny-list, checked for COVERAGE.
 *
 * Run: node scripts/verify-denylist.js
 *
 * ── WHAT THIS PROVES, AND WHAT IT CANNOT ─────────────────────────────────
 *
 * There are two questions about a deny-list and they need different evidence:
 *
 *   1. DOES THE PATTERN SET COVER THE DESTRUCTIVE SPELLINGS?
 *      Pure string matching. Answered here, offline, deterministically.
 *
 *   2. DOES `--dangerously-skip-permissions` ACTUALLY HONOUR A DENY RULE?
 *      A property of the Claude Code binary, not of any file in these repos.
 *      NOTHING IN THIS SCRIPT ANSWERS IT and nothing in it pretends to. The
 *      procedure that does is
 *      `back-office-AI-agents docs/procedures/DENYLIST-PROOF.md`.
 *
 * Conflating the two is the failure this file is careful about: a green run
 * here says the patterns are right, and says NOTHING about whether they are
 * enforced. Both statements are printed at the end so a reader cannot take one
 * for the other.
 *
 * ── THE CONTROL ──────────────────────────────────────────────────────────
 *
 * §2 runs the SAME matcher against the OLD list — the one still inline in
 * `run_architect_midnight.bat` — and requires it to FAIL on the two known gaps.
 * A coverage checker that has never been seen to fail is a checker whose regex
 * might match anything.
 *
 * NO NETWORK, and no `claude` process is started. globalThis.fetch is a tripwire.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKOFFICE = path.resolve(ROOT, '..', 'back-office-AI-agents');
const SETTINGS = path.join(BACKOFFICE, '.claude', 'settings.json');
const WRAPPER = path.join(BACKOFFICE, 'campus', 'agents', '10-the-architect', 'automation', 'run_architect_midnight.bat');

globalThis.fetch = () => { throw new Error('verify-denylist.js made a network call — it must not'); };

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];
function section(t) { console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`); }
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
}
function skip(name, why) { skipped += 1; console.log(`  SKIP  ${name}  — ${why}`); }

/* ═══════════════════════ the matcher ════════════════════════════════════ */

/**
 * Claude Code's Bash permission rule.
 *
 *     Bash(<prefix>:*)   matches <prefix> exactly, or <prefix> followed by a
 *                        SPACE. It does NOT match a command that continues the
 *                        prefix's last token.
 *     Bash(<exact>)      matches that command exactly.
 *
 * ── THE TOKEN BOUNDARY WAS MEASURED, AND THE FIRST VERSION HAD IT WRONG ──
 *
 * This function originally used a plain `startsWith`, which is the obvious
 * reading and is wrong in a direction that OVERSTATES coverage. Measured live
 * on 2026-08-10 against the real binary, same flag, same session mode, one
 * variable changed:
 *
 *   rule Bash(echo DENYLIST-PROBE:*)  cmd `echo DENYLIST-PROBE-1`   -> RAN
 *   rule Bash(echo DENYLIST-PROBE:*)  cmd `echo DENYLIST-PROBE ok`  -> DENIED
 *       ("Permission to use Bash with command echo DENYLIST-PROBE ok has been
 *        denied.")
 *
 * A hyphen continuing the token defeats the rule; a space does not. That is not
 * an academic distinction here — it is exactly the shape of the gap this whole
 * exercise is about. `Bash(git push --force:*)` does NOT cover
 * `git push --force-with-lease`, which a `startsWith` model says it does. The
 * corrected matcher makes that a visible failure instead of a silent pass, and
 * the deny list carries an explicit `--force-with-lease` rule because of it.
 *
 * This is a MODEL of the tool's behaviour built from two live observations. If
 * a future run contradicts it, the tool is right and this function changes.
 */
export function ruleMatches(rule, command) {
  const m = /^Bash\((.*)\)$/.exec(rule.trim());
  if (!m) return false;
  const inner = m[1];
  const cmd = String(command).trim();
  if (inner.endsWith(':*')) {
    const prefix = inner.slice(0, -2);
    return cmd === prefix || cmd.startsWith(`${prefix} `);
  }
  return cmd === inner;
}

export function isDenied(rules, command) {
  return rules.some((r) => ruleMatches(r, command));
}

/* ═══════ §1 the destructive spellings the run must never execute ════════ */
section('§1 coverage — every destructive spelling is matched by some rule');

/**
 * The corpus. Two groups, and the split matters:
 *
 *   MUST_DENY   — commands an unattended run must never execute.
 *   MUST_ALLOW  — commands the run NEEDS. A deny-list that blocks these has
 *                 not made the run safe, it has made it useless, and the next
 *                 session removes the list rather than the over-reach.
 */
const MUST_DENY = [
  // The two known prefix gaps, named as such.
  ['git push -f origin main', 'GAP 1 — short-form force push'],
  ['git push -f', 'GAP 1 — short-form force push, no args'],
  ['git reset HEAD~1', 'GAP 2 — bare reset (moves HEAD, unstages)'],
  ['git reset HEAD~1 --hard', 'GAP 2 — --hard AFTER the ref, so the old prefix missed it'],
  // Already covered by the old list; kept so a regression is visible.
  ['git push --force origin main', 'covered before'],
  ['git reset --hard HEAD~1', 'covered before'],
  ['rm -rf node_modules', 'covered before'],
  ['git clean -fdx', 'covered before'],
  ['git stash drop', 'covered before'],
  ['git merge feature', 'covered before'],
  // Additions beyond the two gaps — the same ACT, different verb.
  ['git push --force-with-lease origin main', 'lease force push is still a force push'],
  ['git push --delete origin feat/x', 'remote branch deletion'],
  ['git push -d origin feat/x', 'remote branch deletion, short form'],
  ['git gc --prune=now', 'destroys the recovery path'],
  ['git rebase -i HEAD~3', 'history rewrite'],
  ['git commit --amend -m x', 'history rewrite'],
  ['git filter-branch --tree-filter x', 'history rewrite'],
  ['git branch -D feat/x', 'branch deletion'],
  ['git tag -d v1', 'tag deletion'],
  ['git checkout -- .', 'discards working-tree changes'],
  ['git restore .', 'discards working-tree changes'],
  ['git stash clear', 'destroys stashes'],
  ['git update-ref -d refs/heads/x', 'ref deletion'],
  ['git reflog expire --expire=now --all', 'destroys the recovery path'],
  ['git gc --prune=now', 'destroys the recovery path'],
  ['rmdir /s /q build', 'Windows recursive delete'],
  ['del /f /q file.txt', 'Windows delete'],
  ['Remove-Item -Recurse -Force x', 'PowerShell delete'],
  ['npx rimraf dist', 'delete by another name'],
  ['wrangler secret delete GITHUB_TOKEN', 'AD-030 territory — never a key action unattended'],
  ['wrangler d1 execute data-center-db --command "DROP TABLE reports"', 'destroys live office data'],
  ['gh repo delete avivnofar/office-AI-agents', 'the worst one'],
];

/**
 * RESIDUAL GAPS — destructive commands a PREFIX RULE CANNOT EXPRESS.
 *
 * Reported every run, never quietly dropped from MUST_DENY. A deny-list whose
 * test suite only contains what it happens to catch will always look complete.
 *
 * `git push origin +main` is the whole list today. The `+` refspec is a force
 * push, and the destructive part is the LAST token — so the only prefix that
 * reaches it is `git push origin`, which would also block every legitimate
 * push the run makes. The rule set cannot distinguish them, and over-blocking
 * push would make the run useless, which is the failure mode that gets a
 * deny-list deleted rather than fixed.
 *
 * What covers it instead: instructions_architect.txt §6 forbids force push in
 * prose, and §5.1's branch rule plus the daily report's branch section make the
 * result visible the next morning. That is weaker than a hard refusal and is
 * recorded as weaker.
 */
const RESIDUAL_GAPS = [
  ['git push origin +main', 'the `+` refspec is a force push and the destructive token is LAST; the only prefix that reaches it is `git push origin`, which would block every legitimate push'],
];

const MUST_ALLOW = [
  'git status --porcelain',
  'git add campus/agents/10-the-architect/runs/2026-08-10-architect.md',
  'git commit -m "night run"',
  'git push',
  'git push origin main',
  'git pull --rebase',
  'git log --oneline -5',
  'git diff --stat',
  'git for-each-ref --format=%(refname:short) refs/heads',
  'node scripts/verify-lifecycle.js',
  'node campus/agents/10-the-architect/automation/dispatch.js --task OB-001 --to slug',
  'npm test',
];

let settings = null;
if (!fs.existsSync(SETTINGS)) {
  skip('the whole of §1 and §2', `no ${SETTINGS} — back-office is private, so this is expected off the owner's machine. NOTHING was verified.`);
} else {
  settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const RULES = settings?.permissions?.deny || [];
  check('the settings file carries a deny list', RULES.length > 0, `${RULES.length} rules`);

  for (const [cmd, why] of MUST_DENY) {
    check(`DENIED: \`${cmd}\`  (${why})`, isDenied(RULES, cmd));
  }

  section('§1a RESIDUAL GAPS — stated, because a silent gap reads as coverage');
  for (const [cmd, why] of RESIDUAL_GAPS) {
    const covered = isDenied(RULES, cmd);
    console.log(`  GAP   \`${cmd}\` is ${covered ? 'NOW COVERED — move it into MUST_DENY' : 'NOT covered by any prefix rule'}`);
    console.log(`        ${why}`);
    // Asserted as STILL A GAP. If a future rule closes it, this check fails and
    // the entry gets promoted — which is the right way round: the failure says
    // "you improved something, update the record".
    check(`RESIDUAL GAP is still accurately described as a gap: \`${cmd}\``, !covered);
  }

  section('§1b the run must still be able to do its job (over-reach is a failure too)');
  for (const cmd of MUST_ALLOW) {
    check(`allowed: \`${cmd}\``, !isDenied(RULES, cmd));
  }

  /* ═════ §2 THE CONTROL — the OLD list must fail on the two gaps ═════════ */
  section('§2 CONTROL — the old inline list, and the gaps it left');

  /*
   * ── OB-079 RECONCILED, 2026-08-16. READ THIS BEFORE CHANGING THE LIST. ──
   *
   * `OLD_RULES` is a FROZEN HISTORICAL SNAPSHOT of the six patterns the
   * wrapper carried before 2026-08-14. It is deliberately NOT a live
   * transcription any more, and it must never be "re-synced" to the wrapper:
   * its entire job is to be the pre-fix list, so §2 can demonstrate that the
   * matcher below is capable of returning "not denied". A control that tracks
   * the thing it controls for is not a control.
   *
   * WHAT HAPPENED, established from evidence rather than inferred:
   *   back-office commit `1666dec`, 2026-08-14 13:57:56 +0300, "OB-053: close
   *   both deny-list gaps". The wrapper's --disallowedTools went from these 6
   *   patterns to 33, widened to match .claude/settings.json.
   *
   * DIRECTION — and this is the question that mattered: **the wrapper became
   * STRICTLY MORE PROTECTIVE, not less.** Every one of the six old patterns is
   * still covered:
   *   rm / git push --force / git clean / git stash drop / git merge — present verbatim;
   *   `git reset --hard:*` — REPLACED BY THE BROADER `git reset:*`, which
   *   matches a superset (that widening is precisely gap 2 being closed).
   * §2b below asserts that superset relation mechanically rather than leaving
   * it as a claim in this comment.
   *
   * AND IT WAS RECORDED. The previous session inferred "someone partially
   * fixed the wrapper without recording it." That inference was wrong. The
   * change is recorded in three places: the commit message, a REM block inside
   * the .bat itself, and — unusually — the commit message PREDICTS this exact
   * verifier failure and explains why it was left ("office-AI-agents is
   * read-only this session; flagged for whoever updates that transcription
   * next, not fixed here"). The signal worked exactly as designed; what was
   * missing was a check pointing at the invariant that still matters.
   *
   * SO THE CHECK CHANGED TARGET. "Does the wrapper still match a hand-typed
   * copy of its own past?" goes stale by construction and fired once, here.
   * "Does the wrapper's live list still match settings.json?" is the invariant
   * OB-053 was closing and the one that catches the NEXT drift — because the
   * failure mode is two lists diverging, not either list changing.
   */
  const OLD_RULES = [
    'Bash(rm:*)',
    'Bash(git push --force:*)',
    'Bash(git reset --hard:*)',
    'Bash(git clean:*)',
    'Bash(git stash drop:*)',
    'Bash(git merge:*)',
  ];

  if (fs.existsSync(WRAPPER)) {
    const bat = fs.readFileSync(WRAPPER, 'utf8');

    // Every "Bash(...)" pattern on the wrapper's --disallowedTools line(s).
    const wrapperRules = [...bat.matchAll(/"(Bash\([^"]*\))"/g)].map((m) => m[1]);
    const settingsDeny = settings.permissions.deny || [];

    check('the wrapper declares a deny list this script can actually read', wrapperRules.length > 0);

    // THE LIVE INVARIANT. Two lists that drift is the failure OB-053 closed,
    // and the failure this project keeps having in other forms (KFM-24).
    const missingFromWrapper = settingsDeny.filter((r) => !wrapperRules.includes(r));
    const missingFromSettings = wrapperRules.filter((r) => !settingsDeny.includes(r));
    check('the wrapper\'s live deny list still covers every rule in .claude/settings.json',
      missingFromWrapper.length === 0, `absent from wrapper: ${missingFromWrapper.join(' ; ')}`);
    check('...and the wrapper carries no rule settings.json does not (so the two are ONE list, not two)',
      missingFromSettings.length === 0, `absent from settings.json: ${missingFromSettings.join(' ; ')}`);

    check('the wrapper still pairs the deny-list with --dangerously-skip-permissions',
      /--dangerously-skip-permissions/.test(bat) && /--disallowedTools/.test(bat));

    /* ═════ §2b THE DIRECTION OF THE 2026-08-14 CHANGE, asserted ═════════ */
    section('§2b the 2026-08-14 wrapper change was in the SAFE direction');

    // For every command the OLD list denied, the CURRENT wrapper must still
    // deny it. This is what "strictly more protective" means, and checking it
    // by running the matcher is the difference between knowing and assuming.
    const OLD_LIST_DENIED = [
      'rm -rf node_modules',
      'git push --force origin main',
      'git reset --hard HEAD~1',
      'git clean -fdx',
      'git stash drop',
      'git merge feature',
    ];
    let allStillDenied = true;
    for (const cmd of OLD_LIST_DENIED) {
      const wasDenied = isDenied(OLD_RULES, cmd);
      const nowDenied = isDenied(wrapperRules, cmd);
      if (wasDenied && !nowDenied) allStillDenied = false;
      check(`still denied after the widening: \`${cmd}\``, !wasDenied || nowDenied);
    }
    check('NO REGRESSION: nothing the pre-2026-08-14 list denied is permitted by the current wrapper',
      allStillDenied);
    check('and the widening closed gap 1 in the wrapper itself: `git push -f` is now denied there',
      isDenied(wrapperRules, 'git push -f origin main'));
    check('and closed gap 2 in the wrapper itself: a bare `git reset` is now denied there',
      isDenied(wrapperRules, 'git reset HEAD~1'));
  } else {
    skip('the wrapper live-list checks', `no ${WRAPPER}`);
  }

  check('CONTROL — the OLD list does NOT stop `git push -f` (gap 1, and the matcher can fail)',
    !isDenied(OLD_RULES, 'git push -f origin main'));
  check('CONTROL — the OLD list does NOT stop a bare `git reset` (gap 2)',
    !isDenied(OLD_RULES, 'git reset HEAD~1'));
  check('CONTROL — the OLD list DOES stop `git push --force` (so it was not simply broken)',
    isDenied(OLD_RULES, 'git push --force origin main'));

  /* ═════ §3 the canary that makes the live proof harmless ═══════════════ */
  section('§3 the live-proof canary');

  check('a harmless canary rule exists, so the live proof needs no destructive command',
    (settings.permissions.deny || []).includes('Bash(echo DENYLIST-PROBE:*)'));
  check('the canary matches the exact probe command in the procedure',
    isDenied(settings.permissions.deny, 'echo DENYLIST-PROBE ok'));
  check('...and does NOT match an ordinary echo (the canary is narrow)',
    !isDenied(settings.permissions.deny, 'echo hello'));
  // The token boundary, pinned as a scenario rather than left in a comment.
  // This is the observation that corrected the matcher, and it is the reason
  // the deny list needs an explicit --force-with-lease rule.
  check('TOKEN BOUNDARY — a hyphen continuing the prefix defeats the rule (measured live)',
    !isDenied(['Bash(echo DENYLIST-PROBE:*)'], 'echo DENYLIST-PROBE-1'));
  check('TOKEN BOUNDARY — a space does not (measured live)',
    isDenied(['Bash(echo DENYLIST-PROBE:*)'], 'echo DENYLIST-PROBE ok'));
  check('TOKEN BOUNDARY — so `git push --force:*` does NOT cover `--force-with-lease`',
    !isDenied(['Bash(git push --force:*)'], 'git push --force-with-lease origin main'));

  const proc = path.join(BACKOFFICE, 'docs', 'procedures', 'DENYLIST-PROOF.md');
  check('the live-enforcement procedure exists and is where the README points',
    fs.existsSync(proc), proc);
}

/* ═══════════════════════════════ summary ════════════════════════════════ */
console.log(`\n${'═'.repeat(72)}`);
console.log(`  ${pass} passed, ${fail} failed, ${skipped} skipped`);
console.log('');
console.log('  PROVEN HERE:      the deny PATTERNS cover the destructive spellings,');
console.log('                    and the old list demonstrably did not.');
console.log('  PROVEN LIVE       (2026-08-10, recorded in DENYLIST-PROOF.md §1):');
console.log('                    the inline --disallowedTools list IS enforced under');
console.log('                    --dangerously-skip-permissions, and the prefix matches');
console.log('                    at a TOKEN BOUNDARY (a hyphen defeats it, a space does not).');
console.log('  PROVEN LIVE       (2026-08-10, §3a AND its §3b control, run by the owner):');
console.log('                    .claude/settings.json does NOT enforce under');
console.log('                    --dangerously-skip-permissions. BOTH the probe and the');
console.log('                    control echoed, so the negative result is real.');
console.log('                    => the inline --disallowedTools list is the ENTIRE');
console.log('                    barrier. There is no second layer, and the settings');
console.log('                    file must NOT be counted as one.');
console.log('  STILL OPEN:       the wrapper\'s own inline list still carries the two');
console.log('                    prefix gaps §2 demonstrates. The exact replacement is');
console.log('                    DENYLIST-PROOF.md §4; the wrapper belongs to the');
console.log('                    Architect chat and is boarded for them as OB-053.');
if (skipped) console.log('\n  A SKIP IS NOT A PASS.');
if (fail) {
  console.log('\n  FAILED:');
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${'═'.repeat(72)}\n`);
process.exit(fail ? 1 : 0);
