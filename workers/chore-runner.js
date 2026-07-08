/**
 * TODO.md-driven cross-project chore rotation (Notebook-X / data-center /
 * archive-alpha) — see config/chore-schedule.json and
 * config/token-economy.json's `chore_automation` block.
 *
 * WIRING-ONLY as of 2026-07-08: runChoreRotationSlot() always resolves
 * routing (which model WOULD handle the task) and logs it, but never
 * actually calls Gemini/Groq/Claude — no live chore-content generation
 * runs until a future session explicitly turns that on. See
 * TOKEN-BUDGET.md's 2026-07-08 session entry.
 */

import choreSchedule from '../config/chore-schedule.json';
import { selectModelForChoreTask, getClaudeBudgetStatus } from './model-router.js';

const REPO_OWNER = 'avivnofar';
const REPO_NAME = 'office-AI-agents';

const PROJECT_TO_TODO_SECTION = {
  'notebook-x': 'Notebook-X',
  'data-center': 'Data-Center',
  'archive-alpha': 'Archive-alpha',
};

/** Cycles nightly through config/chore-schedule.json's project_rotation.projects by day-of-year. */
export function getRotatedProject(date = new Date()) {
  const projects = choreSchedule.project_rotation.projects;
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86_400_000);
  return projects[dayOfYear % projects.length];
}

/**
 * Reads TODO.md from THIS repo (office-AI-agents) via a public raw fetch —
 * a self-repo read, not an external "pull" in the General-rule sense (that
 * cap is checkAndRecordPull()'s 1/day-repo-wide limit on checking out an
 * EXTERNAL project's repo, unrelated to the push-permission check
 * commitFileToRepo()/fileGitHubIssue() run via REPO_TO_PROJECT_KEY), so
 * this read isn't subject to the 1-pull/day cap. Returns the raw text
 * under `## <sectionHeading>` up to the next `## ` heading, or null if the
 * section is missing/empty/unreachable.
 */
export async function fetchTodoSection(sectionHeading) {
  try {
    const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master/TODO.md`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    const heading = `## ${sectionHeading}`;
    const start = text.indexOf(heading);
    if (start === -1) return null;
    const afterHeading = start + heading.length;
    const nextHeading = text.indexOf('\n## ', afterHeading);
    const section = text.slice(afterHeading, nextHeading === -1 ? text.length : nextHeading).trim();
    return section || null;
  } catch {
    return null;
  }
}

/**
 * Runs one chore-rotation slot. Resolves which project is up (or accepts
 * an explicit override), checks whether that project's TODO.md section has
 * any content, and — if so — resolves (but does not execute) the model
 * routing decision. Always no-ops gracefully, never throws.
 */
export async function runChoreRotationSlot(env, { projectKey, label = 'chore_rotation' } = {}) {
  const resolvedProject = projectKey || getRotatedProject();
  const sectionHeading = PROJECT_TO_TODO_SECTION[resolvedProject];

  if (!sectionHeading) {
    console.log(`[chore-runner] ${label}: unrecognized project "${resolvedProject}" — no tasks configured for this project yet.`);
    return { projectKey: resolvedProject, ranTask: false, reason: 'unrecognized project key' };
  }

  const section = await fetchTodoSection(sectionHeading);
  if (!section) {
    console.log(`[chore-runner] ${label}: no tasks configured for this project yet (${resolvedProject}).`);
    return { projectKey: resolvedProject, ranTask: false, reason: 'no tasks configured for this project yet' };
  }

  const budget = await getClaudeBudgetStatus(env);
  const routing = selectModelForChoreTask({ projectKey: resolvedProject, taskType: 'content', overBudget: budget.overBudget });
  console.log(
    `[chore-runner] ${label}: ${resolvedProject} has TODO.md content — would route to ${routing.model} (${routing.reason}). ` +
    'Not executed this session (wiring-only, see TOKEN-BUDGET.md 2026-07-08).'
  );
  return { projectKey: resolvedProject, ranTask: false, reason: 'wiring-only session — no live content generation', routedModel: routing.model, routingReason: routing.reason };
}

/** 16:30-17:00 IL wind-down block: no new work, just an explicit log line. */
export function windDown() {
  console.log('[chore-runner] Wind-down (16:30-17:00 IL) — no new chore work started.');
  return { ok: true };
}
