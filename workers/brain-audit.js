/**
 * workers/brain-audit.js — THE FIRST REAL JOB: audit the brain's skill library.
 *
 * Written 2026-08-28 (Session 33, Item D). Imports nothing, so
 * `scripts/verify-brain-audit.js` can CALL it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT IS ACTUALLY BEING TESTED HERE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Not "can the office write three documents". **Can the Architect take ONE
 * large request and turn it into five executable pieces.**
 *
 * That is the open question, and it is open because the office's other
 * decomposer demonstrably cannot: on 2026-08-28 the Workflow (agent 12) was
 * asked to break down board work and emitted *"handle OB-023"* — a title with
 * a verb in front of it. A task like that is not executable by anything; it
 * hands the whole problem back to whoever reads it.
 *
 * So the acceptance test for this module is a sentence, not a count: **if the
 * Architect emits "audit the brain", the same failure has happened one level
 * up and the session report says so.** `looksLikeATitleWithAVerb()` below is
 * the mechanical half of that check — it cannot judge whether a task is good,
 * but it can refuse the specific shape that has already failed once.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FIVE LENSES ARE FIVE DIFFERENT QUESTIONS, NOT FIVE OPINIONS ON ONE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Three signals agreeing is not the same as the output being right — this
 * estate packaged that finding itself
 * (`campus/brain-export/skills/three-signals-agreeing-is-not-correctness/`),
 * and `reviewerLensQuestion()` in agent-runner.js already applies it to the
 * review desk. The five below are chosen so that no two of them could be
 * satisfied by the same paragraph.
 */

/* ─────────────────────────────── The lenses ─────────────────────────────── */

/**
 * The five, verbatim from the brief, each bound to the persona whose standing
 * question it already is. Frozen: a session that quietly swaps a lens has
 * changed what the audit measured without changing what it claims to have
 * measured.
 */
export const AUDIT_LENSES = Object.freeze([
  {
    key: 'templates',
    agentId: 10,
    agent: 'Architect',
    question: 'Do the brain\'s packaging templates hold structurally, and what breaks as the library grows?',
    deliverable: 1,
  },
  {
    key: 'import',
    agentId: 7,
    agent: 'Team Lead',
    question: 'Which brain skills are worth importing — readable and usable by someone who was not there?',
    deliverable: 2,
  },
  {
    key: 'export',
    agentId: 6,
    agent: 'QA',
    question: 'Which office skills are worth exporting — does each one do what it claims?',
    deliverable: 3,
  },
  {
    key: 'exposure',
    agentId: 13,
    agent: 'Cyber Expert',
    question: 'What is exposed that should not be, in either library?',
    deliverable: null,
  },
  {
    key: 'operability',
    agentId: 5,
    agent: 'IT Chief',
    question: 'Can a skill be applied and diagnosed — how would you know one had failed?',
    deliverable: null,
  },
]);

/**
 * The three deliverables, and they are the ONLY three.
 *
 * D7 names a fourth question — *what skills does the office need to do its
 * work* — and rules it OUT of this round, for a reason worth keeping in the
 * code rather than only in a brief: **it is a build task and it depends on
 * knowing what already exists.** It follows from these three. If it creeps in,
 * the first three get written carelessly in order to reach it.
 */
export const AUDIT_DELIVERABLES = Object.freeze([
  { n: 1, slug: 'brain-packaging-templates', title: 'A review of the brain\'s packaging templates, with concrete improvements' },
  { n: 2, slug: 'brain-skills-worth-importing', title: 'Brain skills worth importing, with reasons' },
  { n: 3, slug: 'office-skills-worth-exporting', title: 'Office skills worth exporting, with reasons' },
]);

/**
 * D6 — deliverable 3 does NOT start from a blank page.
 *
 * Three export items are already packaged and reviewed; the office wrote them
 * and knows why each one earns its place. A task that ignores them is
 * re-deriving work that exists, which is the exact cost the brain was built to
 * stop paying.
 */
export const ALREADY_PACKAGED_FOR_EXPORT = Object.freeze([
  'regression-proof-by-transcription — a proof document carrying its own refutation: transcribe the pre-fix logic and run the new scenario table against it, and a table that passes against the old code is documentation rather than a test.',
  'three-way-blind-evaluation — dedup failure class 6, landing on a permission test.',
  'three-signals-agreeing-is-not-correctness — the axis error, with two independent instances.',
]);

/* ────────────────────────── Slicing the harvest ─────────────────────────── */

/**
 * The digest is ~130,000 characters. That is one file for a person and it is
 * too much for most of the office's lanes, so a task gets a NAMED SLICE.
 *
 * Slices are cut on the digest's own `## ` headings rather than by character
 * offset, because a character offset silently changes meaning the next time
 * the harvest grows — and the harvest is regenerated wholesale every morning.
 */
export const HARVEST_SLICES = Object.freeze({
  templates: {
    label: 'the brain\'s packaging templates, in full, plus the measured intake standard',
    from: '## What is here',
    to: '## The brain\'s governance, excerpted',
  },
  governance: {
    label: 'the brain\'s own governance documents (PIPELINE.md, INDEX.md, ARCHITECT-HANDOFF.md), excerpted',
    from: '## The brain\'s governance, excerpted',
    to: '## `aviv-brain` — skills',
  },
  'brain-library': {
    label: 'every skill, behavior and persona in aviv-brain — name, source, date, description',
    from: '## `aviv-brain` — skills',
    to: '## The office\'s own skills',
  },
  'office-library': {
    label: 'every skill, behavior and persona the office has packaged, plus what is awaiting the brain\'s decision',
    from: '## The office\'s own skills',
    to: '## Every request this harvest made',
  },
  'standard-only': {
    label: 'the measured intake standard across both libraries, and nothing else',
    from: '## The intake standard',
    to: '## The brain\'s packaging templates',
  },
  /*
   * ── THE SIXTH SLICE — BODIES, NOT HEADINGS (SESSION 35, ITEM F) ─────────
   *
   * Deliverable 3 asks *which of the office's skills are worth exporting to
   * the brain*, and its first run returned an honest null result: every slice
   * above carries names and descriptions, and **a writer cannot judge a skill
   * it has not read.** The partner estate asked for exactly this — *"give the
   * writers bodies, not headings, for the specific questions that need them."*
   *
   * It carries the OFFICE's `SKILL.md` files in full and not the brain's.
   * ~150 brain skills at full length is several hundred thousand characters
   * and fits no prompt this office has; the office's own are a bounded set.
   * That asymmetry is a NAMED gap and is stated inside the section itself.
   *
   * ── IT DECLARES ITS OWN CAP, AND THAT IS THE POINT ─────────────────────
   *
   * Measured 2026-08-29 by the harvester itself: **15 files, 155,959
   * characters**. (The session brief
   * estimated "roughly fourteen files, ~60 KB" — the real figure is 2.5x that,
   * and it is the measured one that governs.) At the call site's flat 26,000
   * this slice would arrive **83% truncated**, which is the same failure the
   * null result already reported, dressed as a fix.
   *
   * So a slice may declare `maxChars`, and `sliceHarvest()` prefers it over
   * the caller's. 170,000 carries today's library with ~8% headroom, and a
   * library that outgrows it is REPORTED (`truncated: true`, plus an inline
   * marker naming the cut) rather than silently shortened.
   *
   * ── IT FITS, AND THAT WAS CHECKED RATHER THAN ASSUMED ──────────────────
   *
   * The judgment lane is Cerebras `gpt-oss-120b`, whose per-request input cap
   * is a MEASURED 131,000 tokens. `provider-common.js` estimates at chars/2.75
   * (itself calibrated against a real provider tokenizer), so 170,000 chars is
   * ~61,800 tokens — under half the cap, before the rest of the prompt. And
   * `cerebras-client.js` `checkInputWithinCaps()` REFUSES rather than
   * truncating if that ever stops being true, so an over-cap slice becomes a
   * visible failure and not a confident summary of the part that fitted.
   */
  'office-library-full': {
    label: 'every skill the OFFICE has packaged, IN FULL — bodies, not headings',
    from: '## The office\'s own skills, in full',
    to: '## End of digest',
    maxChars: 170000,
  },
});

/**
 * @param {string} digest - HARVEST.md
 * @param {string} sliceKey - a key of HARVEST_SLICES
 * @param {{maxChars?: number}} [opts]
 * @returns {{ok: boolean, text?: string, label?: string, truncated?: boolean, reason?: string}}
 */
export function sliceHarvest(digest, sliceKey, opts = {}) {
  const spec = HARVEST_SLICES[sliceKey];
  if (!spec) return { ok: false, reason: `unknown harvest slice "${sliceKey}" — the legal keys are ${Object.keys(HARVEST_SLICES).join(', ')}` };
  const text = String(digest || '');
  const start = text.indexOf(spec.from);
  if (start === -1) {
    // NAMED, NEVER SILENTLY FALLEN BACK TO THE WHOLE FILE. A slice that
    // quietly becomes the entire digest is how a bounded prompt stops being
    // bounded, and nobody finds out until a lane returns empty.
    return { ok: false, reason: `the harvest has no section beginning "${spec.from}" — its shape has changed and this slice is stale` };
  }
  const endAt = text.indexOf(spec.to, start + spec.from.length);
  let out = endAt === -1 ? text.slice(start) : text.slice(start, endAt);
  // A SLICE MAY DECLARE ITS OWN CAP, AND IT WINS (Session 35, item F).
  // The call sites pass one flat number for every slice — 26,000 for a task,
  // 30,000 for the decomposition — which is right for five slices of headings
  // and wrong for the one slice of bodies: `office-library-full` is 155,959
  // characters and would arrive 83% truncated. The per-slice value is the
  // considered one and the caller's is the default, so the precedence goes
  // that way round rather than the other.
  const maxChars = Number.isInteger(spec.maxChars) ? spec.maxChars
    : Number.isInteger(opts.maxChars) ? opts.maxChars : 40000;
  let truncated = false;
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n\n[TRUNCATED at ${maxChars} of ${out.length} characters of this slice — say so if what you needed was past the cut.]`;
    truncated = true;
  }
  return { ok: true, text: out, label: spec.label, truncated };
}

/* ──────────────────────── The Architect's decomposition ─────────────────── */

export const DECOMPOSE_SYSTEM = [
  'You are the Architect — Agent 10 of this AI office, root clearance, the office\'s final technical authority.',
  '',
  'You are DECOMPOSING one large request into exactly FIVE executable tasks. This is not a plan and not a summary.',
  '',
  'A task is EXECUTABLE when the agent that receives it needs nothing from you afterwards. That means it names:',
  '  - the ONE question that task answers, in a form that has a wrong answer;',
  '  - what to look at, by name;',
  '  - what to produce, concretely enough that two people would recognise the same thing as finished.',
  '',
  'A task is NOT executable when it is a title with a verb in front of it. "Handle the board." "Audit the brain."',
  '"Review the templates." Those hand the whole problem back to whoever reads them. The office has already emitted',
  'exactly that failure once this week, from a different decomposer, and this decomposition exists to find out',
  'whether you do it too. Do not write one.',
  '',
  'Answer with a SINGLE JSON object and nothing else — no prose before or after, no markdown fence:',
  '{ "tasks": [ { "lens": "<one of the five lens keys given to you>", "agent_id": <number>, "harvest_slice": "<one of the slice keys given to you>", "question": "<the ONE question, one sentence>", "instruction": "<what the agent must do, 60-150 words, concrete>", "deliverable": "<what it produces and which of the three numbered deliverables it feeds, or the words: feeds all three>" } ] }',
  '',
  'Exactly five tasks, one per lens, in the order the lenses are given. Use each lens key exactly once.',
].join('\n');

export function buildDecomposePrompt({ harvestSlice, sliceLabel, standardSlice }) {
  return [
    'THE REQUEST, from the owner, in full:',
    '',
    'Audit `aviv-brain`\'s skill library against the office\'s own. Three deliverables:',
    ...AUDIT_DELIVERABLES.map((d) => `  ${d.n}. ${d.title}`),
    '',
    'THE FIVE LENSES. Five different questions, not five opinions on one — three agreeing signals are not the same',
    'as the output being right, and this office packaged that finding itself. Each is bound to the persona whose',
    'standing question it already is:',
    '',
    ...AUDIT_LENSES.map((l) => `  - lens key \`${l.key}\` — Agent ${l.agentId}, the ${l.agent}: ${l.question}`),
    '',
    'THE SLICES you may assign. The harvest digest is ~130,000 characters; each task gets ONE named slice, and the',
    'slice must be the one that task actually needs:',
    '',
    ...Object.entries(HARVEST_SLICES).map(([k, v]) => `  - \`${k}\` — ${v.label}`),
    '',
    'ALREADY PACKAGED FOR EXPORT — deliverable 3 starts from these three, not from a blank page:',
    ...ALREADY_PACKAGED_FOR_EXPORT.map((s) => `  - ${s}`),
    '',
    'OUT OF SCOPE, and a task that drifts into it is a defective task: "what skills does the office NEED".',
    'That is a build task, it depends on knowing what already exists, and it follows from these three deliverables.',
    'If it creeps in, the first three get written carelessly in order to reach it.',
    '',
    `WHAT YOU HAVE BEEN GIVEN TO DECOMPOSE FROM — ${sliceLabel}:`,
    '---',
    harvestSlice,
    '---',
    '',
    'AND THE MEASURED INTAKE STANDARD ACROSS BOTH LIBRARIES:',
    '---',
    standardSlice,
    '---',
    '',
    'Produce the JSON object now.',
  ].join('\n');
}

/**
 * The mechanical half of D3's test.
 *
 * It cannot tell a good task from a bad one. It CAN refuse the one shape that
 * has already failed in this office this week — an imperative verb, a noun
 * phrase, and nothing else. Short, no question mark, no named object.
 */
export function looksLikeATitleWithAVerb(instruction) {
  const s = String(instruction || '').trim();
  if (!s) return true;
  if (s.length < 60) return true;
  const sentences = s.split(/[.?!]\s/).filter((x) => x.trim().length > 3);
  return sentences.length < 2;
}

/**
 * Validates the Architect's answer. REFUSES rather than repairing: a
 * decomposition this function quietly patched would be measured as his and it
 * would not be his, and D3's whole point is finding out what he actually does.
 */
export function parseDecomposition(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, reason: 'no JSON object found in the Architect\'s reply' };
  let parsed;
  try { parsed = JSON.parse(s.slice(start, end + 1)); } catch (err) { return { ok: false, reason: `not valid JSON: ${err.message}` }; }
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : null;
  if (!tasks) return { ok: false, reason: '"tasks" is missing or is not an array' };
  if (tasks.length !== AUDIT_LENSES.length) {
    return { ok: false, reason: `expected exactly ${AUDIT_LENSES.length} tasks, got ${tasks.length}` };
  }

  const legalLenses = new Set(AUDIT_LENSES.map((l) => l.key));
  const legalSlices = new Set(Object.keys(HARVEST_SLICES));
  const problems = [];
  const seen = new Set();
  const out = [];

  tasks.forEach((t, i) => {
    const lens = String(t?.lens || '').trim();
    if (!legalLenses.has(lens)) problems.push(`task ${i + 1}: lens "${lens}" is not one of the five`);
    if (seen.has(lens)) problems.push(`task ${i + 1}: lens "${lens}" is used twice`);
    seen.add(lens);
    const slice = String(t?.harvest_slice || '').trim();
    if (!legalSlices.has(slice)) problems.push(`task ${i + 1}: harvest_slice "${slice}" is not one of the named slices`);
    const instruction = String(t?.instruction || '').trim();
    if (looksLikeATitleWithAVerb(instruction)) {
      problems.push(`task ${i + 1} (${lens}): the instruction is a title with a verb in front of it, not an executable task — "${instruction.slice(0, 80)}"`);
    }
    const known = AUDIT_LENSES.find((l) => l.key === lens);
    out.push({
      lens,
      agentId: Number(t?.agent_id) || known?.agentId || null,
      harvestSlice: slice,
      question: String(t?.question || '').trim(),
      instruction,
      deliverable: String(t?.deliverable || '').trim(),
    });
  });

  if (problems.length) return { ok: false, reason: problems.join(' · '), tasks: out };
  return { ok: true, tasks: out };
}

/** The decomposition, rendered for the file the office reads it back out of. */
export function renderDecomposition({ today, tasks, model, usage }) {
  const L = [];
  L.push(`# BRAIN AUDIT — THE ARCHITECT'S DECOMPOSITION, ${today}`);
  L.push('');
  L.push('**Classification:** private · **Derived — do not hand-edit.**');
  L.push('Produced by the Architect (agent 10) on the Anthropic API, `component:\'architect\'` sub-budget.');
  L.push('');
  L.push('> One large request — *audit `aviv-brain`\'s skill library against the office\'s own* — turned into five');
  L.push('> executable tasks. **This document is the test, not the plan.** The office\'s other decomposer emitted');
  L.push('> *"handle OB-023"* on 2026-08-28: a title with a verb in front of it, executable by nothing.');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify({ tasks }, null, 2));
  L.push('```');
  L.push('');
  for (const [i, t] of tasks.entries()) {
    const lens = AUDIT_LENSES.find((l) => l.key === t.lens);
    L.push(`## Task ${i + 1} — \`${t.lens}\` · Agent ${t.agentId}${lens ? ` (the ${lens.agent})` : ''}`);
    L.push('');
    L.push(`**The one question:** ${t.question}`);
    L.push('');
    L.push(`**Harvest slice:** \`${t.harvestSlice}\` — ${HARVEST_SLICES[t.harvestSlice]?.label || 'UNKNOWN SLICE'}`);
    L.push('');
    L.push(`**Instruction:**\n\n${t.instruction}`);
    L.push('');
    L.push(`**Deliverable:** ${t.deliverable}`);
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push(`_Model: ${model || 'unrecorded'}${usage ? ` · ${usage.inputTokens} in / ${usage.outputTokens} out` : ''}._`);
  L.push('');
  return L.join('\n');
}

/* ─────────────────────────── Executing one task ─────────────────────────── */

export function buildTaskPrompt({ task, sliceText, sliceLabel, deliverableTitle }) {
  return [
    `THE CLIENT asked the office to audit \`aviv-brain\`'s skill library against its own. The Architect decomposed`,
    'that into five tasks and this is yours. You answer ONE question and nobody else answers it.',
    '',
    `YOUR QUESTION: ${task.question}`,
    '',
    'YOUR INSTRUCTION, from the Architect, verbatim:',
    '---',
    task.instruction,
    '---',
    '',
    deliverableTitle ? `WHAT YOU ARE PRODUCING: ${deliverableTitle}` : `WHAT YOU ARE PRODUCING: ${task.deliverable}`,
    '',
    // The standing anti-fabrication instruction. On 2026-08-17 this office's
    // first live review claimed it had run a script and executed CLI flags; it
    // had been handed one markdown file. The prompt is where that is stopped.
    'WHAT YOU HAVE, EXACTLY: the harvest slice reproduced below, and nothing else.',
    'You have NOT opened any repository, run any command, or read any skill file in full — the slice carries each',
    'item\'s frontmatter and section headings, not its body. Do not write as though you had read more. Where a',
    'judgement needs something you were not given, SAY SO AND NAME WHAT YOU WOULD NEED. An honest "I cannot tell',
    'from this" is a real finding; an invented one is the only thing that would make this worthless.',
    '',
    'Name specific items. A finding that names no skill is not a finding about a library.',
    '',
    `THE SLICE — ${sliceLabel}:`,
    '---',
    sliceText,
    '---',
    '',
    'Write it as markdown, ready to file. Start with a one-paragraph answer to your question, then the detail.',
    'Under 700 words. Do not restate the instruction back at us.',
  ].join('\n');
}

/** Where a deliverable lands: the channel, where the owner already reads. */
export function deliverablePath(today, slug) {
  return `channel/from-office/${today}-review-brain-audit-${slug}.md`;
}

export function renderDeliverable({ today, n, title, lens, agentId, agentName, question, sliceLabel, truncated, text, provider }) {
  const L = [];
  L.push('---');
  L.push('from: office');
  L.push(`date: ${today}`);
  L.push('kind: delivery');
  L.push(`re: brain-audit-${n}`);
  L.push('status: open');
  L.push('---');
  L.push('');
  L.push(`# Brain audit, deliverable ${n} — ${title}`);
  L.push('');
  L.push(`**Written by:** Agent ${agentId}${agentName ? ` — ${agentName}` : ''} · **Lens:** \`${lens}\``);
  L.push(`**The one question this answers:** ${question}`);
  L.push('');
  L.push('---');
  L.push('');
  L.push(String(text || '').trim());
  L.push('');
  L.push('---');
  L.push('');
  L.push('## What the writer was actually given');
  L.push('');
  L.push(`One slice of \`campus/brain-export/audit/HARVEST.md\` — ${sliceLabel}.${truncated ? ' **It was TRUNCATED**, and the writer was told so.' : ''}`);
  L.push('');
  L.push('The slice carries each item\'s frontmatter and section headings, **not its body**. No repository was opened,');
  L.push('no command was run, and no skill file was read in full. A claim above that depends on a skill\'s body is a');
  L.push('claim the writer could not have checked, and it should be read that way.');
  L.push('');
  L.push(`_Produced autonomously by the \`brain_audit\` block, provider ${provider || 'unrecorded'}._`);
  L.push('');
  return L.join('\n');
}
