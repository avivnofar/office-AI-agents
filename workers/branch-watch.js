/**
 * workers/branch-watch.js — OPEN BRANCHES AND THEIR AGE, IN THE DAILY REPORT.
 *
 * Built 2026-08-10, wiring OFFICE-POLICY.md A7's second half:
 *
 *   > **Branches — the hard rule.** **One active branch per project.** A run
 *   > that finds an active branch continues on it. **Creating a new branch when
 *   > an active one exists is forbidden.** [...]
 *   > **Open branches and their age appear in the daily report.** An
 *   > accumulating branch backlog is the failure this rule exists to prevent.
 *
 * ── THE RULE HAS TWO HALVES AND THEY LIVE IN DIFFERENT PLACES ────────────
 *
 * The PROHIBITION ("do not open a second branch") binds a WRITER, and the only
 * writers that open branches are sessions and the midnight run — never this
 * Worker, which commits to the default branch through
 * `repo-write.js commitFileToRepo()` and has no branch API at all. So the
 * prohibition is enforced where the writers read it: the policy digest every
 * agent carries (`office-policy.js` A7), and
 * `back-office-AI-agents campus/agents/10-the-architect/automation/
 * instructions_architect.txt` §5.1 for the night run.
 *
 * The VISIBILITY half is this file. It is the half A7 says exists because *"the
 * owner has been burned by branch backlogs from headless runs"* — a prohibition
 * nobody can check is a prohibition that decays, and the daily report is where
 * the owner would notice.
 *
 * ── WHAT THIS COULD NOT SEE, 2026-08-06..2026-08-10 ──────────────────────
 *
 * The warehouse. `WAREHOUSE_REPO_TOKEN` was deliberately unset (repo-write.js,
 * plan 4.1), so the Worker could not read that repo at all — and the warehouse
 * is where the night run does most of its building, which made it the repo
 * most likely to accumulate branches unseen.
 *
 * That was a REPORTED GAP, not a silent one: `fetchOpenBranches()` returned an
 * explicit `unreadable` entry for it, `renderBranchSection()` printed it, and
 * `scripts/report-watchdog.mjs` — which runs on the owner's machine with all
 * three checkouts — covered it from the other side. A section that simply
 * omitted the warehouse would have read as "the warehouse has no open
 * branches", the single most misleading thing this feature could publish.
 *
 * **CORRECTED 2026-08-11 (appended, not edited in place — A15):** the owner
 * set `WAREHOUSE_REPO_TOKEN` this session — the second lock on the warehouse
 * code-write exception opening (`config/project-permissions.json`
 * `code_write_warehouse_2026-08`). `fetchOpenBranches()` reads the token's
 * presence at request time (`WATCHED_REPOS`'s `expectedUnreadable` field
 * below), so this repo is now read LIVE, exactly like the other two, with no
 * code change required — the gap this section described closed itself the
 * moment the secret was set. `report-watchdog.mjs` remains a second,
 * independent path (owner's machine, all three checkouts) rather than the
 * warehouse's only coverage; the two are now redundant on this repo instead
 * of complementary, which is a safe direction for two mechanisms to drift in.
 *
 * PURE render, network only in `fetchOpenBranches()` — so the verifier can
 * exercise every shape without a token.
 */

/**
 * The repos this Worker can ask about, and the secret each needs.
 *
 * Mirrors `repo-write.js REPO_TO_TOKEN_SECRET` in structure but is NOT imported
 * from it, deliberately: that map governs WRITES and this is a read. Importing
 * it would make a future change to write permissions silently change what the
 * daily report can see, which is exactly the "two mechanisms agreeing by
 * accident" shape repo-write.js's own header warns about.
 */
export const WATCHED_REPOS = Object.freeze([
  { repo: 'office-AI-agents', tokenSecret: 'GITHUB_TOKEN', why: 'the public repo — the office writes its own reports here' },
  { repo: 'back-office-AI-agents', tokenSecret: 'BACKOFFICE_REPO_TOKEN', why: 'the brain — plans, board, character files' },
  {
    repo: 'warehouse-office-AI-agents',
    tokenSecret: 'WAREHOUSE_REPO_TOKEN',
    why: 'the workshop — where the night run builds',
    // CORRECTED 2026-08-11 (appended, not silently edited — A15): the owner
    // set WAREHOUSE_REPO_TOKEN this session (the second lock on the code-write
    // exception opening), so `env?.[spec.tokenSecret]` below now reads truthy
    // and this repo is read LIVE like the other two — `expectedUnreadable`
    // has not applied since. `report-watchdog.mjs` (the owner's machine) is
    // no longer this repo's only branch coverage; it is now redundant with
    // the Worker's own daily report rather than compensating for a gap in it.
    // Kept as a fallback field, not deleted, in case the token is ever unset
    // again — a `!token` Worker restart must not read as a new incident.
    expectedUnreadable: 'WAREHOUSE_REPO_TOKEN is not configured on the Worker, so its branches cannot be listed. (Historically true 2026-08-06..2026-08-10 by deliberate owner choice, plan 4.1 — see PROJECT-SPEC-TABLES.md\'s A7 row for the correction dated 2026-08-11.)',
  },
]);

const REPO_OWNER = 'avivnofar';

/** Whole days between an ISO timestamp and now. Floor, so "0d" means today. */
export function ageInDays(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86400000);
}

/**
 * Turns the GitHub branches payload into rows, dropping the default branch.
 *
 * The DEFAULT BRANCH IS PASSED IN, never guessed. Two of the three repos use
 * `main` and one uses `master`; a hardcoded guess reported both of the others
 * as A7 violations on its first live run (see report-watchdog.mjs, which made
 * exactly that mistake and had it caught by running it).
 *
 * @param {Array} branches  GitHub `GET /repos/{o}/{r}/branches` payload
 * @param {object} tipDates {branchName: ISO date of its tip commit}
 * @returns {Array<{branch, ageDays, sha}>}
 */
export function parseBranchRows(branches, tipDates = {}, defaultBranch = null, now = Date.now()) {
  if (!Array.isArray(branches)) return [];
  return branches
    .filter((b) => b?.name && b.name !== defaultBranch)
    .map((b) => ({
      branch: b.name,
      sha: (b.commit?.sha || '').slice(0, 7) || null,
      // `null` means the tip date could not be read — rendered as "age unknown",
      // never as 0. An unknown age shown as 0 makes a six-week-old branch look
      // like today's, which is the opposite of what this section is for.
      ageDays: tipDates[b.name] ? ageInDays(tipDates[b.name], now) : null,
    }))
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
}

/**
 * A7's verdict per repo. One active branch is the ceiling.
 *
 * `blockedFromNew` is the operative output — it is what a reader (or a future
 * caller) needs in order to obey the rule, rather than the raw count.
 */
export function branchVerdict(rows) {
  const readable = rows.filter((r) => !r.unreadable);
  return {
    violation: readable.some((r) => r.branches.length > 1),
    blockedFromNew: readable.filter((r) => r.branches.length >= 1).map((r) => r.repo),
    unreadable: rows.filter((r) => r.unreadable).map((r) => r.repo),
  };
}

/**
 * Renders the daily-report section. PURE.
 *
 * Written for the daily report, which is a STRING TEMPLATE THAT MAKES NO MODEL
 * CALL — so this is not budgeted and can afford to be complete. See
 * office-context.js BUDGETS' note on why the report shape is the generous one.
 */
export function renderBranchSection(rows, opts = {}) {
  const v = branchVerdict(rows);
  const lines = ['## Open branches (policy A7 — one active branch per project)', ''];

  for (const row of rows) {
    if (row.unreadable) {
      lines.push(`- **${row.repo}** — NOT READABLE FROM THE WORKER. ${row.unreadable}`);
      continue;
    }
    if (!row.branches.length) {
      lines.push(`- **${row.repo}** — no open branches (default \`${row.defaultBranch || '?'}\`).`);
      continue;
    }
    lines.push(`- **${row.repo}** — ${row.branches.length} open (default \`${row.defaultBranch || '?'}\`):`);
    for (const b of row.branches) {
      lines.push(`  - \`${b.branch}\` — ${b.ageDays === null ? 'age unknown (tip commit date unreadable)' : `${b.ageDays} day(s) old`}${b.sha ? ` · \`${b.sha}\`` : ''}`);
    }
  }

  if (v.violation) {
    lines.push('', '> **A7 VIOLATION — more than one active branch in a project.** '
      + 'A new branch is permitted only after the previous is merged or explicitly abandoned by the owner, '
      + 'and abandoning is an owner act. This is the branch backlog A7 exists to prevent.');
  }
  if (v.blockedFromNew.length) {
    lines.push('', `**No new branch may be opened in:** ${v.blockedFromNew.join(', ')} — continue the existing one.`);
  }
  if (v.unreadable.length) {
    lines.push('', `*The Worker cannot see: ${v.unreadable.join(', ')}. `
      + 'That is not "no branches" — it is "not checked from here". '
      + '`scripts/report-watchdog.mjs` covers these from the owner\'s machine.*');
  }
  if (opts.error) lines.push('', `*Branch data was incomplete this cycle: ${opts.error}*`);

  return lines.join('\n');
}

/* ─────────────────────────────── Fetching ─────────────────────────────── */

async function ghJson(url, token) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'data-center-agent-sim',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
    },
  }).catch(() => null);
  if (!res?.ok) return { ok: false, status: res?.status ?? 0 };
  return { ok: true, body: await res.json().catch(() => null) };
}

/**
 * Fetches open branches for every watched repo.
 *
 * NEVER THROWS — same posture as `recordRepoWrite()`. This runs inside the
 * daily-summary path; a branch section that could take down the daily report
 * would be a monitoring feature that causes the outage it monitors for.
 *
 * Costs at most 2 + N requests per repo (the repo record for its default
 * branch, the branch list, and one commit lookup per branch). It runs ONCE per
 * day cycle, not per model call.
 */
export async function fetchOpenBranches(env) {
  const rows = [];
  for (const spec of WATCHED_REPOS) {
    const token = env?.[spec.tokenSecret];
    if (!token) {
      rows.push({
        repo: spec.repo,
        unreadable: spec.expectedUnreadable
          || `${spec.tokenSecret} is not configured on the Worker, so its branches cannot be listed.`,
      });
      continue;
    }

    const base = `https://api.github.com/repos/${REPO_OWNER}/${spec.repo}`;
    const meta = await ghJson(base, token);
    const list = await ghJson(`${base}/branches?per_page=100`, token);
    if (!list.ok) {
      rows.push({ repo: spec.repo, unreadable: `GitHub returned HTTP ${list.status} for its branch list.` });
      continue;
    }

    const defaultBranch = meta.ok ? (meta.body?.default_branch ?? null) : null;
    const candidates = (list.body || []).filter((b) => b?.name && b.name !== defaultBranch);

    // Tip dates, capped. A repo with fifty branches is already the failure this
    // section reports; spending fifty subrequests to date them all inside a
    // Worker invocation would risk the daily report itself. The cap is STATED
    // in the output rather than applied silently.
    const tipDates = {};
    const CAP = 10;
    for (const b of candidates.slice(0, CAP)) {
      const c = await ghJson(`${base}/commits/${b.commit?.sha}`, token);
      if (c.ok) tipDates[b.name] = c.body?.commit?.committer?.date || c.body?.commit?.author?.date;
    }

    rows.push({
      repo: spec.repo,
      defaultBranch,
      branches: parseBranchRows(list.body || [], tipDates, defaultBranch),
      ...(candidates.length > CAP ? { note: `only the first ${CAP} branches were dated` } : {}),
    });
  }
  return rows;
}
