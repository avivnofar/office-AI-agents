/**
 * THE AUTOMATIONS PANEL — session 40, Item C.
 *
 * ══ WHY THIS EXISTS ══════════════════════════════════════════════════════
 *
 * Every defect chased in the week to 2026-08-30 was one shape: something ran,
 * or did not, and nobody knew. A doubled day counter. An `admin_desk` that
 * looked broken and was correctly scheduled. A log pull swallowed by
 * `.gitignore`. An email on a rest day. A daily-obligation check that had never
 * fired. **Not one was caught by the system. Every one was caught because a
 * person looked** — by holding `daily-schedule.json` next to `block_admissions`
 * and comparing two lists by eye.
 *
 * This page is that comparison, done by the machine. It is a VIEW OVER DATA
 * THAT ALREADY EXISTS and it introduces no new mechanism, no new table and no
 * new write: `daily-schedule.json` says what should run, `block_admissions`
 * records what did, `repo_writes.author` (session 40 Item B) records what each
 * one produced, and the GitHub Actions API says the same for the half of the
 * office's automation that does not live in this Worker.
 *
 * ══ THE ROW THAT MATTERS IS THE ONE THAT ISN'T THERE ═════════════════════
 *
 * A panel that lists what ran is a log. The question the owner has been
 * answering by hand is the inverse — *what should have run by now and has no
 * row?* — so `MISSED` is computed here rather than left to the reader, and it
 * is the only state that sorts to the top.
 *
 * It is computed against ISRAEL time and only for blocks whose time has already
 * passed, because a block scheduled for 16:00 has not missed anything at 14:00.
 * The distinction between "not yet due" and "due and absent" is the entire
 * value of the page; collapsing them would reproduce, on a dashboard, exactly
 * the ambiguity the heartbeat rows were added to remove.
 *
 * ══ WHAT THIS PANEL DOES NOT KNOW, AND SAYS SO ═══════════════════════════
 *
 * `block_admissions` records the ADMISSION DECISION, not the outcome. A block
 * with `decision: run` and `actual: 0` was admitted and did nothing, which is a
 * different fact from either "ran" or "did not run" — it is shown as its own
 * state (`RAN, PRODUCED NOTHING`) rather than folded into success.
 */

/* ── The schedules, by day-of-week ───────────────────────────────────────── */

/** 1-7, Sunday..Saturday, matching daily-schedule.json's applies_to_day_of_week. */
export function scheduleForDay(scheduleConfig, dayOfWeek) {
  for (const key of ['full_day_schedule', 'friday_schedule', 'saturday_schedule']) {
    const s = scheduleConfig?.[key];
    if (Array.isArray(s?.applies_to_day_of_week) && s.applies_to_day_of_week.includes(Number(dayOfWeek))) {
      return { key, label: s.label || null, blocks: s.blocks || [] };
    }
  }
  return { key: null, label: null, blocks: [] };
}

/**
 * Which `repo_writes.author` value a block's own writes carry.
 *
 * WHY A MAP AND NOT A DERIVATION. The author slugs were chosen at each call
 * site in session 40 Item B and several do not equal the block type — a
 * `report` block writes as `block:report_pipeline`, and a `meeting` block
 * writes three different authors. A derivation would silently produce a slug
 * nothing matches, and the page would then show "produced nothing" for a block
 * that produced plenty. **A wrong join here is indistinguishable from a broken
 * automation**, which is the one confusion this page must not create, so the
 * mapping is explicit and a block that is absent from it is reported as
 * `attribution not wired` rather than as zero.
 *
 * `AGENT_ATTRIBUTED` is its own value and not an empty string: those blocks
 * write as `agent:<N>`, so a block-prefix count would correctly find zero and
 * incorrectly read as "it produced nothing".
 */
export const AGENT_ATTRIBUTED = Symbol('agent-attributed');

export const BLOCK_AUTHOR_PREFIX = Object.freeze({
  meeting: 'block:meeting',
  weekly_meeting: 'block:meeting',
  report: 'block:report_pipeline',
  weekly_report: 'block:report_pipeline',
  weekly_summary: 'block:weekly_summary',
  owner_channel: 'block:owner_channel',
  admin_desk: 'block:admin_desk',
  qa_instruments: 'block:qa_instruments',
  spare_time: 'block:side_plots',
  repair: AGENT_ATTRIBUTED,
  architect_approval: AGENT_ATTRIBUTED,
  guide_draft: 'block:guide_review',
  guide_review: 'block:guide_review',
  guide_verify: 'block:guide_verify',
});

/**
 * The KV kill switches, and which of them may be TOGGLED from this page.
 *
 * `retired` is not a disabled toggle — it is a different thing on the page. The
 * case work (R-001, owner decision, 2026-08-23) and the guides pipeline (off in
 * live SIM_KV since 2026-08-20, schedule blocks removed 2026-08-29) were
 * retired deliberately and their state is worth SHOWING. Offering a one-click
 * re-enable beside a recorded owner decision is not a convenience, it is a
 * button that undoes a decision nobody asked to revisit — so those two rows
 * carry a date and no control at all.
 *
 * Every `trigger` here is a case that ALREADY EXISTS in `/api/agents/trigger`.
 * No switch is invented and nothing that has no switch today gets a control.
 */
export const SWITCHES = Object.freeze([
  { key: 'office_context_enabled', trigger: 'office_context_toggle', what: 'The office context block in every agent and meeting prompt.' },
  { key: 'owner_channel_enabled', trigger: 'owner_channel_toggle', what: 'Reading the owner’s channel and recording what was read.' },
  { key: 'learning_loop_enabled', trigger: 'learning_loop_toggle', what: 'The WRITE half of the improvement loop — journals, adaptations, active context.' },
  { key: 'improvement_loop_enabled', trigger: 'improvement_loop_toggle', what: 'The CAPTURE half — refusals and conclusions recorded.' },
  { key: 'report_pipeline_enabled', trigger: 'report_pipeline_toggle', what: 'The daily and weekly report pipeline.' },
  { key: 'architect_liaison_enabled', trigger: 'architect_liaison_toggle', what: 'Filing the headless midnight run’s output as a D1 report.' },
  { key: 'action_items_to_board_enabled', trigger: 'action_items_to_board_toggle', what: 'Meeting action items reaching the board’s inbox.' },
  { key: 'routing_enabled', trigger: 'routing_toggle', what: 'Task-type model routing.' },
  { key: 'judge_sampler_enabled', trigger: 'judge_sampler_toggle', what: 'Quality sampling of the office’s own output.' },
  { key: 'meeting_context_amendments_enabled', trigger: 'meeting_amendments_toggle', what: 'Meetings writing conclusions into agent character files.' },
  {
    key: 'cases_enabled', trigger: null, what: 'The Q&A case engine.',
    retired: 'Retired by the owner 2026-08-23 — RETIRED-CAPABILITIES.md R-001. Nine case_batch blocks left the schedule on 2026-08-29.',
  },
  {
    key: 'guides_enabled', trigger: null, what: 'The guides pipeline.',
    retired: 'Off in live SIM_KV since 2026-08-20; five guide_* blocks left the schedule 2026-08-29. The switch and every module behind it are untouched.',
  },
]);

/* ── The join ────────────────────────────────────────────────────────────── */

/** "HH:MM" -> minutes, or null. */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function firstSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const cut = t.search(/(?<=[.!?])\s/);
  const head = cut > 0 ? t.slice(0, cut) : t;
  return head.length > 180 ? `${head.slice(0, 180).trimEnd()}… [the rest is in daily-schedule.json]` : head;
}

/**
 * One row per scheduled block for the day, joined against what actually
 * happened. Pure — every input is passed in, so the verifier runs it without
 * D1, without the network and without a clock.
 *
 * @param {object}  o
 * @param {object}  o.scheduleConfig   daily-schedule.json, as the Worker reads it
 * @param {number}  o.dayOfWeek        1-7, Sunday..Saturday, ISRAEL
 * @param {string}  o.israelTime       "HH:MM" now, ISRAEL
 * @param {Array}   o.admissions       block_admissions rows for the day
 * @param {Array}   o.writes           `{author, n, last_at}` for the day
 * @param {boolean} o.admissionsRead   false when D1 could not be read
 */
export function buildAutomationsView({
  scheduleConfig, dayOfWeek, israelTime, admissions = [], writes = [], admissionsRead = true,
} = {}) {
  const sched = scheduleForDay(scheduleConfig, dayOfWeek);
  const nowMin = minutesOf(israelTime);

  const byBlock = new Map();
  for (const a of admissions) {
    const k = `${a.block}@${a.at}`;
    // Last row wins: a block re-run in the same day is described by its most
    // recent admission, and `runs` says it happened more than once.
    const prev = byBlock.get(k);
    byBlock.set(k, { row: a, runs: (prev?.runs || 0) + 1 });
  }

  const writeCount = new Map();
  for (const w of writes) writeCount.set(String(w.author), { n: Number(w.n || 0), lastAt: w.last_at || null });

  const rows = sched.blocks.map((b) => {
    const hit = byBlock.get(`${b.type}@${b.time}`);
    const blockMin = minutesOf(b.time);
    const due = nowMin !== null && blockMin !== null && blockMin <= nowMin;

    let state;
    if (!admissionsRead) state = 'UNKNOWN — THE ADMISSION RECORD COULD NOT BE READ';
    else if (!hit) state = due ? 'MISSED — DUE AND NO ROW' : 'NOT YET DUE';
    else if (hit.row.decision === 'defer') state = 'DEFERRED — the budget refused it';
    else if (hit.row.decision === 'oversize') state = 'OVERSIZE — its estimate exceeds the whole budget';
    else if (Number(hit.row.actual) === 0) state = 'RAN, PRODUCED NOTHING';
    else state = 'RAN';

    const prefix = BLOCK_AUTHOR_PREFIX[b.type];
    let produced;
    if (prefix === undefined) {
      produced = 'attribution not wired for this block type';
    } else if (prefix === AGENT_ATTRIBUTED) {
      produced = 'writes as agent:<N>, not as a block — see the agent rows';
    } else {
      let n = 0;
      let lastAt = null;
      for (const [author, v] of writeCount) {
        if (!author.startsWith(prefix)) continue;
        n += v.n;
        if (!lastAt || (v.lastAt && v.lastAt > lastAt)) lastAt = v.lastAt;
      }
      produced = n ? `${n} file${n === 1 ? '' : 's'} (last ${lastAt})` : 'nothing attributed to it today';
    }

    return {
      time: b.time,
      type: b.type,
      meetingType: b.meeting_type || null,
      // The schedule's labels run to 900 characters of history. The panel wants
      // the first sentence; the file has the rest, and the row SAYS so.
      note: firstSentence(b.label),
      state,
      missed: state.startsWith('MISSED'),
      decision: hit?.row?.decision || null,
      estimate: hit?.row?.estimate ?? null,
      actual: hit?.row?.actual ?? null,
      ranAt: hit?.row?.created_at || null,
      runs: hit?.runs || 0,
      produced,
    };
  });

  return {
    scheduleKey: sched.key,
    scheduleLabel: sched.label,
    dayOfWeek,
    israelTime,
    rows,
    missedCount: rows.filter((r) => r.missed).length,
    admissionsRead,
  };
}

/* ── GitHub Actions — the other half of the office's automation ──────────── */

/**
 * THE HALF THAT IS NOT IN THIS WORKER.
 *
 * Seven workflows in `.github/workflows/` run on GitHub's cron, not on
 * Cloudflare's, and nothing in `block_admissions` has ever known about them. A
 * panel that showed only the Worker's blocks would be trusted for the half it
 * does not show — which is worse than not existing, because the owner would
 * stop checking the half it omits.
 *
 * It IS reachable: the Actions API answers with the same `GITHUB_TOKEN` this
 * Worker already holds for the public repo. What is NOT guaranteed is the
 * token's SCOPE — a fine-grained token without `actions: read` returns 403, and
 * that is reported as "the token cannot read this", never as "no workflows".
 * An empty list and a refused read must not look the same; that is the same
 * distinction this whole page is built on.
 *
 * The declared CRON is NOT read here. It lives in the workflow YAML and this
 * Worker does not parse YAML; a guessed schedule beside a real last-run time
 * would be the more dangerous half of the pair. The page says where the cron is
 * instead of inventing it.
 */
export async function fetchWorkflowRuns(env, { owner, repo } = {}) {
  const token = env?.GITHUB_TOKEN;
  if (!token) {
    return {
      ok: false, owner: owner || null, repo: repo || null, workflows: [],
      reason: 'no GITHUB_TOKEN in this environment — the Actions half cannot be read',
    };
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'data-center-agent-sim',
    Accept: 'application/vnd.github+json',
  };
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows?per_page=50`, { headers })
    .catch(() => null);
  if (!res?.ok) {
    const status = res?.status ?? 'no response';
    return {
      ok: false,
      owner: owner || null,
      repo: repo || null,
      workflows: [],
      reason: `the GitHub Actions API answered ${status}`
        + (res?.status === 403
          ? ' — the token is present and cannot read Actions (scope). That is NOT the same as there being no workflows.'
          : ''),
    };
  }
  const list = await res.json().catch(() => null);
  /*
   * EVERY workflow, not only the active ones — corrected on the panel's first
   * live load, 2026-08-30. The filter was `state === 'active'`, and the live
   * repo has three workflows in `disabled_manually`: agent-reports,
   * scheduled-claude and archive-architect. It rendered five rows out of eight
   * and said nothing about the other three.
   *
   * **A workflow the owner believes is running and that GitHub has disabled is
   * the exact failure this panel exists to catch**, and hiding it was C3's own
   * warning happening inside the fix for C3: a panel that shows only part of
   * the automations gets trusted for the part it does not show. The state is a
   * COLUMN now, not a filter.
   */
  const workflows = list?.workflows || [];

  const runsRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=${Math.max(30, workflows.length * 3)}`,
    { headers },
  ).catch(() => null);
  const runs = runsRes?.ok ? ((await runsRes.json().catch(() => null))?.workflow_runs || []) : [];

  const latest = new Map();
  for (const r of runs) if (!latest.has(r.workflow_id)) latest.set(r.workflow_id, r);

  return {
    ok: true,
    owner: owner || null,
    repo: repo || null,
    reason: runsRes?.ok ? null : 'the workflow LIST was readable but the RUN history was not — every last-run below is unknown, not absent',
    workflows: workflows.map((w) => {
      const r = latest.get(w.id) || null;
      return {
        /*
         * `id` and the enclosing `owner`/`repo` were added 2026-08-31 for the
         * enable/disable controls. They are ADDITIVE: no request this function
         * makes changed, no field was removed, and nothing it already reported
         * is computed differently. The id is GitHub's own numeric workflow id
         * and is what the write endpoint validates against `parseWorkflowRef()`
         * before it is ever spliced into a URL.
         */
        id: w.id,
        name: w.name,
        path: w.path,
        state: w.state,
        // `disabled_manually` is not a result — it is the reason there will
        // never be another run, and it belongs where the eye looks first.
        lastRunAt: r?.run_started_at || r?.created_at || null,
        conclusion: w.state === 'active' ? (r?.conclusion || (r ? r.status : null)) : `DISABLED (${w.state})`,
        event: r?.event || null,
      };
    }),
  };
}

/* ── The Actions half, made WRITABLE (2026-08-31) ────────────────────────── */

/**
 * WHY THE READ-ONLY HALF STOPPED BEING READ-ONLY.
 *
 * `fetchWorkflowRuns()` above has shown a workflow's state since 2026-08-30,
 * including the three this repo has in `disabled_manually`. Showing the state
 * and being unable to change it is the smaller half of the job: the owner then
 * reads the panel, learns a workflow is off, and leaves for github.com to do
 * something about it — which is the hand-comparison this page was built to
 * retire, moved one step later.
 *
 * **The reason it was read-only was never a permission.** It was that no write
 * call had been written. `GITHUB_TOKEN` is a classic PAT carrying `repo`, which
 * is the scope the enable/disable endpoints require; the `workflow` scope it
 * does NOT carry governs pushing changes to workflow *files*, which nothing
 * here does. That claim is not taken on trust — the session that added this
 * probed it live before trusting it.
 *
 * ── A 403 HERE MEANS TWO DIFFERENT THINGS, AND THE STATUS CANNOT TELL YOU
 *    WHICH (measured 2026-08-31) ─────────────────────────────────────────
 *
 * The probe that was SPECIFIED was `disable` against an already-disabled
 * workflow, on the reasoning that disabling something already disabled changes
 * nothing and so is a free permission test. It is not a permission test at all.
 * GitHub answers:
 *
 *     403  {"message": "Unable to disable a workflow that is not active."}
 *
 * — and it answers the same 403 to a token that genuinely lacks the scope. The
 * probe was run with a token carrying `gist, read:org, repo, workflow`
 * (`X-Oauth-Scopes` on the response says so) and still got 403. **A status code
 * that means both "you may not" and "it is already that way" is the estate's
 * own recurring defect arriving from outside**, and the first version of this
 * module reported that 403 as "the token cannot do this (scope)" — which would
 * have sent the owner to replace a credential that was fine.
 *
 * So the BODY is read, not just the status, and a state conflict is its own
 * code. And the real zero-effect probe is the other direction: `enable` against
 * an ALREADY-ACTIVE workflow returns **204** and leaves the state at `active`.
 * That is what proved the scope on 2026-08-31, through this Worker's own
 * `GITHUB_TOKEN`.
 *
 * ── THE ID IS DIGITS, AND IT IS CHECKED BEFORE IT IS A URL ───────────────
 *
 * `parseWorkflowRef()` keeps the discipline `parseItemRef()` and
 * `parseTaskQuery()` already keep: the identity arrives in a query string, is
 * validated against a fixed pattern, and only then is spliced into a path.
 * GitHub also accepts a workflow's FILE NAME at this endpoint; that spelling is
 * deliberately not accepted here, because a file name is a free-form string
 * reaching a URL path and digits are not.
 */
export function parseWorkflowRef(rawId) {
  const s = String(rawId ?? '').trim();
  if (!s) return { ok: false, reason: 'no workflow id was given' };
  if (!/^[0-9]{1,20}$/.test(s)) {
    return {
      ok: false,
      reason: 'a workflow id is digits only — GitHub also accepts a workflow FILE NAME at this endpoint '
        + 'and this office deliberately does not, because a file name is a free-form string reaching a URL path',
    };
  }
  return { ok: true, id: s };
}

/**
 * Which control, if any, a workflow row gets.
 *
 * THE `SWITCHES` IDIOM, HELD. A row that must not be flipped gets NO control at
 * all — not a greyed-out one — and carries the reason as text, exactly as the
 * two retired kill switches do. A disabled-looking button is an invitation with
 * a refusal attached; a sentence is an answer.
 *
 * Only two states get a control, and the rest say what they are:
 *
 *   `active`              -> disable
 *   `disabled_manually`   -> enable
 *   `disabled_inactivity` -> NOTHING. GitHub disabled this itself after 60 days
 *                            of repo inactivity. The enable endpoint would work,
 *                            and a one-click re-enable would hide the fact that
 *                            the repo went quiet — which is the finding.
 *   anything else         -> NOTHING, and the state is named.
 *
 * @param {object}  w            a row from fetchWorkflowRuns().workflows
 * @param {object}  o
 * @param {boolean} o.writable   may THIS token write to the repo the row is in
 * @param {string}  o.repo       the repo the row is in, for the refusal text
 * @param {string}  o.writeRepo  the one repo this token may write to
 */
export function workflowControl(w, { writable, repo, writeRepo } = {}) {
  if (!writable) {
    return {
      action: null,
      why: `not writable from here — this Worker holds one public-repo token, scoped to ${writeRepo || 'the public repo'}`
        + `${repo ? `, and this row is in ${repo}` : ''}. Another repo needs a different credential and the owner’s decision.`,
    };
  }
  if (w?.state === 'active') return { action: 'disable', label: 'disable', why: null };
  if (w?.state === 'disabled_manually') return { action: 'enable', label: 'enable', why: null };
  if (w?.state === 'disabled_inactivity') {
    return {
      action: null,
      why: 'GitHub disabled this itself after 60 days without repo activity. A one-click re-enable here would hide '
        + 'that the repo went quiet, which is the finding — re-enable it on github.com, deliberately.',
    };
  }
  return { action: null, why: `state “${String(w?.state ?? 'unknown')}” — no control is offered for a state this panel does not model.` };
}

/** The one live state each direction is allowed to land in. */
const EXPECTED_STATE = { enable: 'active', disable: 'disabled_manually' };

/**
 * Enable or disable ONE workflow, then READ THE LIVE STATE BACK.
 *
 * ── EVERY FAILURE IS ITS OWN SENTENCE ────────────────────────────────────
 *
 * `fetchWorkflowRuns()` already refuses to render "the token cannot read this"
 * and "there are no workflows" as one line. The write half holds the same
 * standard, and these codes are the whole of it:
 *
 *   `forbidden`      403 whose BODY is not a state complaint — the token
 *                    cannot do this. NOT "the call was wrong".
 *   `state_conflict` 403 whose body says the workflow is already in the state
 *                    asked for. NOT a permission problem at all: the panel that
 *                    was clicked from is stale. See the header.
 *   `not_found`    404 — no workflow with that id. NOT "you were refused".
 *   `unreachable`  no response at all. UNKNOWN, not failed: the call may well
 *                  have landed and this side never learned the answer.
 *   `unchanged`    the API accepted it (204) and a fresh read still reports the
 *                  old state. This is the one that most deserves its own
 *                  message and is the easiest to paper over, because the write
 *                  itself answered success.
 *   `unverified`   accepted (204) and the follow-up read itself failed. Neither
 *                  "it worked" nor "it did not" — say which half is unknown.
 *
 * ── THE RE-READ IS A FRESH GET, NOT THE WRITE'S OWN 204 ──────────────────
 *
 * Same rule the KV toggle above the switch table keeps, for the same recorded
 * reason: this estate has a documented case of a toggle answering 200 and
 * changing nothing. GitHub's workflow state is not eventually consistent the
 * way Workers KV is, so — unlike that toggle — one read is allowed to be the
 * verdict here; the ten-second second look is not needed and is not faked.
 *
 * DISABLING SOMETHING ALREADY DISABLED IS A SUCCESS, deliberately: the expected
 * state is compared against the LIVE state, never against a change. That is
 * what makes the permission probe possible with no live effect.
 */
export async function setWorkflowEnabled(env, { owner, repo, id, enable } = {}) {
  const token = env?.GITHUB_TOKEN;
  if (!token) {
    return { ok: false, code: 'no_token', message: 'no GITHUB_TOKEN in this environment — nothing was attempted' };
  }
  const ref = parseWorkflowRef(id);
  if (!ref.ok) return { ok: false, code: 'bad_id', message: ref.reason };
  if (typeof enable !== 'boolean') {
    return { ok: false, code: 'bad_direction', message: 'the direction must be a boolean `enable` — no default is guessed' };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'data-center-agent-sim',
    Accept: 'application/vnd.github+json',
  };
  const verb = enable ? 'enable' : 'disable';
  const base = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${ref.id}`;

  const res = await fetch(`${base}/${verb}`, { method: 'PUT', headers }).catch(() => null);
  if (!res) {
    return {
      ok: false, code: 'unreachable', verb, id: ref.id,
      message: `the ${verb} call got no response at all. This is UNKNOWN, not failed — it may have landed. `
        + 'Reload the panel and read the live state before trying again.',
    };
  }
  if (res.status !== 204) {
    /*
     * THE BODY, NOT ONLY THE STATUS. GitHub's own message is the only thing
     * that separates "you may not" from "it is already that way" on a 403 —
     * see this section's header for the measurement. It is quoted verbatim in
     * every branch below rather than paraphrased, because a paraphrase of a
     * refusal reads exactly like a diagnosis.
     */
    const detail = await res.json().catch(() => null);
    const gh = typeof detail?.message === 'string' ? detail.message : null;
    const quoted = gh ? ` GitHub said: “${gh}”.` : ' GitHub sent no readable message.';

    if (res.status === 403 && gh && /unable to (disable|enable) a workflow|already (active|disabled)/i.test(gh)) {
      return {
        ok: false, code: 'state_conflict', httpStatus: 403, verb, id: ref.id,
        message: `this is NOT a permission problem, even though GitHub answered 403 — that status covers both. `
          + `The workflow is already in the state the ${verb} asked for, so nothing changed and nothing is broken.`
          + `${quoted} The panel you clicked from is stale; reload it.`,
      };
    }
    if (res.status === 403) {
      return {
        ok: false, code: 'forbidden', httpStatus: 403, verb, id: ref.id, githubMessage: gh,
        message: 'GitHub answered 403 and its message is not a state complaint, so this reads as scope: this token '
          + 'cannot enable or disable workflows. That is NOT the same as the call being wrong — the id and the repo '
          + `may both be correct. Replacing the token is an owner action.${quoted}`,
      };
    }
    if (res.status === 404) {
      return {
        ok: false, code: 'not_found', httpStatus: 404, verb, id: ref.id, githubMessage: gh,
        message: `GitHub answered 404: no workflow with id ${ref.id} in ${owner}/${repo}. That is NOT a refusal — `
          + `the token was accepted and the thing asked for does not exist. Reload the panel; the list may have moved.${quoted}`,
      };
    }
    return {
      ok: false, code: `http_${res.status}`, httpStatus: res.status, verb, id: ref.id, githubMessage: gh,
      message: `GitHub answered ${res.status} to the ${verb} call — neither the 204 that means done, nor a 403 or 404 `
        + `this panel knows how to explain. Nothing is assumed about the workflow’s state.${quoted}`,
    };
  }

  /* THE FOLLOW-UP READ. Not the 204 — a fresh read of the live state, which is
     the only thing that answers "did it take". */
  const back = await fetch(base, { headers }).catch(() => null);
  if (!back?.ok) {
    return {
      ok: false, code: 'unverified', httpStatus: 204, verb, id: ref.id,
      message: `the ${verb} call was accepted (204), and the follow-up read `
        + `${back ? `answered ${back.status}` : 'got no response'} — so the WRITE is known and the RESULT is not. `
        + 'Reload the panel before acting on the state shown for this row.',
    };
  }
  const live = await back.json().catch(() => null);
  const state = live?.state ?? null;
  const expected = EXPECTED_STATE[verb];
  if (state !== expected) {
    return {
      ok: false, code: 'unchanged', httpStatus: 204, verb, id: ref.id, state,
      message: `GitHub accepted the ${verb} call (204) and a fresh read still reports “${String(state)}”, not `
        + `“${expected}”. The write SUCCEEDED and the state DID NOT MOVE — those are different facts and this is the `
        + 'second one. Nothing on this page should be trusted for this row until it is checked on github.com.',
    };
  }
  return {
    ok: true, code: 'confirmed', httpStatus: 204, verb, id: ref.id, state,
    message: `${verb}d, and read back live from GitHub: the workflow is now “${state}”.`,
  };
}
