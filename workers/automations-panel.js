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
    return { ok: false, reason: 'no GITHUB_TOKEN in this environment — the Actions half cannot be read', workflows: [] };
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
    reason: runsRes?.ok ? null : 'the workflow LIST was readable but the RUN history was not — every last-run below is unknown, not absent',
    workflows: workflows.map((w) => {
      const r = latest.get(w.id) || null;
      return {
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
