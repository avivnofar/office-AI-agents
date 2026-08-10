/**
 * workers/capability-audit.js — FOR EVERY AGENT: DOES IT HAVE THE MEANS ITS
 * ROLE REQUIRES?
 *
 * Written 2026-08-10. Pure: **this module imports nothing**, the same rule
 * `owner-channel.js`, `deliverable-lifecycle.js` and `office-policy.js` keep, and
 * for the same reason — plain `node` must be able to load it so
 * `scripts/verify-capability-audit.js` exercises the real code rather than a
 * hand-mirror of it, and `scripts/capability-audit.mjs` can drive it against the
 * real repo.
 *
 * ── THE FINDING THIS EXISTS FOR ──────────────────────────────────────────
 *
 * The Designer (agent 9) existed on paper for two months and never worked. Not
 * blocked — she never had the means. The bible said she generates visual assets;
 * no image-capable provider was wired anywhere in the repo; plan 5.1 specified
 * one and it was never built; four board tasks and REQ-002 sat behind it.
 *
 * That is a NEW VARIANT of this project's dominant defect
 * (`ARCHITECTURAL-DECISIONS.md` §7). The six recorded instances are all *a gate
 * that is never called*. This one is **a role that was never activated**:
 * documentation asserts a capability and no code path supplies it.
 *
 * ── WHY THE CENSUS COULD NOT HAVE CAUGHT IT ──────────────────────────────
 *
 * `meeting-decisions.js` has an output census, and completing it (same date) was
 * the right thing to do — but it is structurally the wrong instrument for this,
 * and that is worth stating precisely rather than treating the two as
 * alternatives:
 *
 *   A CENSUS MEASURES AGAINST WORK THAT WAS DISPATCHED AND ACTIVITY THAT WAS
 *   RECORDED. The Designer was never dispatched anything, and her Q&A asks kept
 *   her activity row warm. **She never read as idle. She read as absent from the
 *   question.**
 *
 * So there are two mechanisms because one cannot do both jobs:
 *
 *   computeOutputCensus()  catches a role that STOPPED working.
 *   auditCapabilities()    catches a role that NEVER STARTED.
 *
 * A census can only see the agents it was told to look at, doing the kinds of
 * work it was told to count. This one starts from the BIBLE — what the role is
 * for — and asks whether anything in the codebase could possibly do it.
 *
 * ── THE VERDICTS, AND WHY `UNPROVEN` IS NOT A ROUNDING ERROR ─────────────
 *
 * Lifted from board task OB-001, which is the Cyber Expert's own standing work
 * and whose wording is exact: *"A gate with no verifier exercising it is
 * UNPROVEN, never CALLED."* Applied to a capability:
 *
 *   SUPPLIED    the means resolves AND something exercises it
 *   UNPROVEN    the means resolves and NOTHING exercises it
 *   UNSUPPLIED  no code path supplies it — the Designer's old state
 *
 * Collapsing UNPROVEN into SUPPLIED is exactly the mistake this project has made
 * six times. A file that exists and exports the right symbol tells you nothing
 * about whether it is ever reached; that is the whole content of §7.
 *
 * ── WHAT THIS AUDIT CANNOT DO, STATED SO IT IS NOT ASSUMED ───────────────
 *
 * It resolves a NAMED reference. It does not discover a capability nobody wrote
 * down: a role requirement absent from `config/capability-manifest.json` is
 * invisible here, and an audit that reports "no gaps" because nobody told it
 * about a capability is worse than no audit. The manifest is explicitly a
 * non-exhaustive starting list, to be extended — the same wording, and the same
 * warning, that OB-001 carries.
 *
 * It also cannot prove a supplied capability is CALLED ON THE SCHEDULED PATH.
 * `semantic-search` is the standing example: the client resolves, a verifier
 * exercises it, and nothing in production calls it. That is why the manifest
 * carries a `caveat` field and why this module surfaces it verbatim instead of
 * folding it into a verdict.
 */

/* ────────────────────────────── Verdicts ───────────────────────────────── */

export const VERDICTS = Object.freeze(['SUPPLIED', 'UNPROVEN', 'UNSUPPLIED']);

/** Verdicts that mean the office cannot do the thing at all. Named as a set
 *  because three callers ask this question and "not SUPPLIED" is the wrong test
 *  — UNPROVEN means it probably works and nobody has shown it. */
export const GAP_VERDICTS = Object.freeze(['UNSUPPLIED']);

/**
 * Resolves ONE capability against a supply index.
 *
 * @param {string} id
 * @param {object} capability - one entry from the manifest's `capabilities`
 * @param {object} supplyIndex - what actually exists, built by the runner:
 *   `{ modules: { 'workers/x.js': ['symbolA', ...] },
 *      lanes:   { 'lanes.image.roles.draft': true },
 *      verifiers: ['scripts/verify-routing.js', ...] }`
 * @returns {{id, verdict, reason, means, exercisedBy, caveat, agents}}
 */
export function resolveCapability(id, capability, supplyIndex) {
  const means = capability?.supplied_by || { kind: 'none' };
  const agents = capability?.agents || [];
  const base = { id, what: capability?.what || null, agents, means, caveat: means.caveat || null };

  // The manifest itself says nothing supplies this. No resolution needed, and
  // the `why` is carried through verbatim: a gap whose reason is summarised is a
  // gap someone will re-investigate.
  if (means.kind === 'none') {
    return {
      ...base,
      verdict: 'UNSUPPLIED',
      reason: means.why || 'the manifest records no supplying code path and gives no reason — which is itself worth fixing',
      exercisedBy: null,
    };
  }

  if (means.kind === 'module') {
    const symbols = supplyIndex?.modules?.[means.ref];
    if (!symbols) {
      return { ...base, verdict: 'UNSUPPLIED', reason: `the named module does not exist: ${means.ref}`, exercisedBy: null };
    }
    if (means.symbol && !symbols.includes(means.symbol)) {
      /*
       * A file that exists whose symbol does not is the WORST of the three
       * failures and the one most likely to be read as fine: the reference looks
       * resolvable, a reader greps the filename and finds it, and the function
       * the role depends on is not in there. This project has a name for the
       * shape — a pointer resolved by structural completeness alone — and it
       * reached the published brain library twice before anyone checked.
       */
      return {
        ...base,
        verdict: 'UNSUPPLIED',
        reason: `${means.ref} exists but does not export "${means.symbol}" — a reference that resolves by filename and not by symbol`,
        exercisedBy: null,
      };
    }
  }

  if (means.kind === 'lane') {
    if (!supplyIndex?.lanes?.[means.symbol]) {
      return {
        ...base,
        verdict: 'UNSUPPLIED',
        reason: `no routable lane at ${means.symbol} in ${means.ref}`,
        exercisedBy: null,
      };
    }
  }

  // The means resolves. Now: does anything exercise it?
  const exercisedBy = capability.exercised_by || null;
  if (!exercisedBy) {
    return {
      ...base,
      verdict: 'UNPROVEN',
      reason: 'the means resolves and the manifest names no verifier that exercises it. OB-001\'s rule: with nothing exercising it, it is UNPROVEN, never SUPPLIED',
      exercisedBy: null,
    };
  }
  if (!supplyIndex?.verifiers?.includes(exercisedBy)) {
    return {
      ...base,
      verdict: 'UNPROVEN',
      reason: `the manifest names ${exercisedBy} as the verifier and that file does not exist — a claim about being tested that nothing backs`,
      exercisedBy,
    };
  }

  return { ...base, verdict: 'SUPPLIED', reason: null, exercisedBy };
}

/**
 * The whole audit: every capability, then every agent rolled up.
 *
 * @param {object} manifest    - config/capability-manifest.json
 * @param {object} supplyIndex - see resolveCapability()
 * @param {object} [opts]
 * @param {number[]} [opts.dormantAgents] - agents whose inactivity is a
 *   deliberate state rather than a missing capability. The Architect (10) is the
 *   only one, and he is passed in rather than hardcoded so the caller has to
 *   state the exemption instead of inheriting it silently.
 * @returns {{capabilities: Array, agents: Array, counts: object, unknownAgents: Array}}
 */
export function auditCapabilities(manifest, supplyIndex, { dormantAgents = [10] } = {}) {
  const capabilities = Object.entries(manifest?.capabilities || {})
    .map(([id, cap]) => resolveCapability(id, cap, supplyIndex));

  const roster = Object.entries(manifest?.agents || {}).map(([id, a]) => ({ id: Number(id), ...a }));
  const rosterIds = new Set(roster.map((a) => a.id));

  /*
   * A capability naming an agent who is not on the roster is REPORTED, never
   * dropped. A silently ignored agent id is how a capability stops being audited
   * for anybody: the row still looks covered, and the agent it was for has
   * vanished from the rollup.
   */
  const unknownAgents = [];
  for (const cap of capabilities) {
    for (const agentId of cap.agents) {
      if (!rosterIds.has(Number(agentId))) unknownAgents.push({ capability: cap.id, agentId });
    }
  }

  const agents = roster.map((a) => {
    const mine = capabilities.filter((c) => c.agents.map(Number).includes(a.id));
    const gaps = mine.filter((c) => GAP_VERDICTS.includes(c.verdict));
    const unproven = mine.filter((c) => c.verdict === 'UNPROVEN');
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      bibleClaim: a.bible_claim || null,
      dormant: dormantAgents.includes(a.id),
      outputKinds: a.output_kinds || [],
      total: mine.length,
      supplied: mine.filter((c) => c.verdict === 'SUPPLIED').length,
      unproven: unproven.map((c) => c.id),
      gaps: gaps.map((c) => ({ id: c.id, what: c.what, reason: c.reason })),
      // CAN THIS AGENT WORK AT ALL? A role with zero supplied capabilities is
      // the Designer's old state and is reported as its own fact, not left to be
      // inferred from a count of gaps.
      canWork: mine.some((c) => c.verdict === 'SUPPLIED'),
    };
  });

  return {
    capabilities,
    agents,
    unknownAgents,
    counts: {
      capabilities: capabilities.length,
      supplied: capabilities.filter((c) => c.verdict === 'SUPPLIED').length,
      unproven: capabilities.filter((c) => c.verdict === 'UNPROVEN').length,
      unsupplied: capabilities.filter((c) => c.verdict === 'UNSUPPLIED').length,
      agentsWithGaps: agents.filter((a) => a.gaps.length > 0).length,
      agentsWhoCannotWork: agents.filter((a) => !a.canWork && !a.dormant).length,
    },
  };
}

/**
 * ROLE CLAIM vs SUPPLIED CAPABILITY — the load-bearing half.
 *
 * Everything above audits capabilities the manifest already knows about. This
 * asks the sharper question the session brief names: **what does the bible say a
 * persona DOES that no capability supplies?**
 *
 * It is answered from `output_kinds` — the kinds of thing a role is *for* —
 * cross-referenced against which of those kinds any SUPPLIED capability could
 * actually produce. A role whose declared output kinds are all unproducible is a
 * role that cannot do its job however many generic capabilities it shares with
 * everyone else. That distinction is the Designer's exactly: she had
 * `ask-data-center`, `hebrew-composition` and `routine-drafting` like everybody,
 * so any count of her capabilities looked healthy, and she could not make a
 * picture.
 *
 * @param {object} audit - the result of auditCapabilities()
 * @param {object} manifest
 * @param {object} producibleKinds - `{ '<output_kind>': ['<capability id>', ...] }`,
 *   supplied by the caller rather than derived, because "which capability
 *   produces a visual_asset" is a judgement about the office and belongs in the
 *   manifest's own vocabulary, not in a string match this module invents.
 */
export function auditRoleClaims(audit, manifest, producibleKinds) {
  const byId = new Map(audit.capabilities.map((c) => [c.id, c]));

  return audit.agents.map((a) => {
    const kinds = (a.outputKinds || []).map((kind) => {
      const producers = producibleKinds?.[kind] || [];
      const supplied = producers.filter((cid) => byId.get(cid)?.verdict === 'SUPPLIED');
      const unsupplied = producers.filter((cid) => byId.get(cid)?.verdict === 'UNSUPPLIED');
      return {
        kind,
        // No producer NAMED at all is different from producers that are all
        // unsupplied: the first is a gap in this manifest, the second is a gap in
        // the office. Reported apart, because the fixes are different.
        producers,
        producible: supplied.length > 0,
        unmapped: producers.length === 0,
        blockedBy: unsupplied,
      };
    });

    const unproducible = kinds.filter((k) => !k.producible && !k.unmapped);
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      dormant: a.dormant,
      kinds,
      unproducibleKinds: unproducible.map((k) => k.kind),
      unmappedKinds: kinds.filter((k) => k.unmapped).map((k) => k.kind),
      // The verdict a reader wants first: can this role produce ANY of what it
      // is for?
      roleVerdict: kinds.length === 0
        ? 'NO_OUTPUT_KINDS_DECLARED'
        : (kinds.every((k) => k.producible) ? 'FULLY_SUPPLIED'
          : (kinds.some((k) => k.producible) ? 'PARTLY_SUPPLIED' : 'CANNOT_PRODUCE_ITS_OWN_OUTPUT')),
    };
  });
}

/* ─────────────────────────────── Rendering ─────────────────────────────── */

/**
 * The audit as a findings document — the Cyber Expert's deliverable shape.
 *
 * Renders GAPS FIRST and in full. A report that leads with 24 healthy rows and
 * buries three gaps at the bottom is a report whose reader stops before the part
 * that matters; the office has a rule about exactly this for its own weekly
 * reports and it applies here.
 */
export function renderAudit(audit, roleClaims, { date, sha = null } = {}) {
  const c = audit.counts;
  const lines = [
    '# Capability audit — does each agent have the means its role requires?',
    '',
    `**Run:** ${date}${sha ? ` · repo \`${sha}\`` : ''} · **By:** Agent 13 — The Cyber Expert`,
    '**Tool:** `office-AI-agents/workers/capability-audit.js` `auditCapabilities()`, run by'
    + ' `scripts/capability-audit.mjs` · **Manifest:** `config/capability-manifest.json`',
    '',
    '> **This is the second of two mechanisms, and the first one structurally cannot'
    + ' do its job.** `workers/meeting-decisions.js` `computeOutputCensus()` catches a role'
    + ' that STOPPED working, by measuring output. This catches a role that NEVER STARTED,'
    + ' by asking whether any code path supplies what the role is for. An agent that was'
    + ' never dispatched anything is not idle — it is absent from the census\'s question.',
    '',
    `**Counts:** ${c.capabilities} capabilities — **${c.supplied} SUPPLIED** ·`
    + ` **${c.unproven} UNPROVEN** · **${c.unsupplied} UNSUPPLIED**.`
    + ` ${c.agentsWithGaps} of ${audit.agents.length} agents carry at least one gap;`
    + ` ${c.agentsWhoCannotWork} cannot work at all.`,
    '',
    '| Verdict | Means it |',
    '|---|---|',
    '| `SUPPLIED` | The named code path exists and a verifier exercises it |',
    '| `UNPROVEN` | The code path exists and **nothing exercises it**. OB-001\'s rule, applied to a capability: with nothing exercising it, it is UNPROVEN, never SUPPLIED |',
    '| `UNSUPPLIED` | **No code path supplies it.** The Designer\'s state for two months |',
    '',
    '---',
    '',
    '## The gaps — no code path supplies these',
    '',
  ];

  const gaps = audit.capabilities.filter((x) => GAP_VERDICTS.includes(x.verdict));
  if (!gaps.length) {
    lines.push('_None. Every capability in the manifest resolves to a code path._');
    lines.push('');
    lines.push('**Read that narrowly.** It means every capability SOMEBODY WROTE DOWN resolves.'
      + ' A role requirement missing from the manifest is invisible to this audit, which is why'
      + ' the manifest is explicitly a non-exhaustive starting list.');
  } else {
    for (const g of gaps) {
      const owners = g.agents.map((id) => {
        const a = audit.agents.find((x) => x.id === Number(id));
        return a ? `Agent ${a.id} — ${a.name}` : `Agent ${id}`;
      });
      lines.push(`### \`${g.id}\` — UNSUPPLIED`);
      lines.push('');
      lines.push(`- **What it is:** ${g.what}`);
      lines.push(`- **Whose role needs it:** ${owners.join(' · ')}`);
      lines.push(`- **Why nothing supplies it:** ${g.reason}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## Unproven — the code exists and nothing exercises it');
  lines.push('');
  const unproven = audit.capabilities.filter((x) => x.verdict === 'UNPROVEN');
  if (!unproven.length) lines.push('_None._');
  else for (const u of unproven) lines.push(`- \`${u.id}\` — ${u.reason}`);

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Per agent');
  lines.push('');
  lines.push('| # | Agent | Capabilities | Supplied | Gaps | Can work? | Role verdict |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const a of audit.agents) {
    const rc = roleClaims.find((r) => r.id === a.id);
    lines.push(`| ${a.id} | ${a.name}${a.dormant ? ' _(dormant)_' : ''} | ${a.total} | ${a.supplied}`
      + ` | ${a.gaps.length ? a.gaps.map((g) => `\`${g.id}\``).join(', ') : '—'}`
      + ` | ${a.canWork ? 'yes' : (a.dormant ? 'dormant — deliberate' : '**NO**')}`
      + ` | \`${rc?.roleVerdict || 'n/a'}\` |`);
  }

  lines.push('');
  lines.push('## What the bible says a role does that nothing supplies');
  lines.push('');
  lines.push('_Derived from each role\'s declared `output_kinds` — the kinds of thing the role'
    + ' is FOR — against which of those kinds a SUPPLIED capability could actually produce. This'
    + ' is the half that catches the Designer\'s shape: she held every generic capability the'
    + ' office has, so any count of her capabilities looked healthy, and she could not make a'
    + ' picture._');
  lines.push('');
  for (const r of roleClaims) {
    if (r.roleVerdict === 'FULLY_SUPPLIED') continue;
    lines.push(`### Agent ${r.id} — ${r.name} — \`${r.roleVerdict}\``);
    lines.push('');
    if (r.unproducibleKinds.length) {
      lines.push(`- **Cannot produce:** ${r.unproducibleKinds.map((k) => `\`${k}\``).join(', ')}`);
      for (const k of r.kinds.filter((x) => !x.producible && !x.unmapped)) {
        lines.push(`  - \`${k.kind}\` needs ${k.producers.map((p) => `\`${p}\``).join(' or ')} — all UNSUPPLIED`);
      }
    }
    if (r.unmappedKinds.length) {
      lines.push(`- **No capability is even NAMED for:** ${r.unmappedKinds.map((k) => `\`${k}\``).join(', ')}`
        + ' — a gap in this manifest rather than (necessarily) in the office. Reported apart because the fix is different.');
    }
    lines.push('');
  }

  if (audit.unknownAgents.length) {
    lines.push('## Capabilities naming an agent who is not on the roster');
    lines.push('');
    lines.push('_Reported, never dropped: a silently ignored agent id leaves the capability row'
      + ' looking covered while the agent it was for has vanished from the rollup._');
    lines.push('');
    for (const u of audit.unknownAgents) lines.push(`- \`${u.capability}\` names agent ${u.agentId}`);
    lines.push('');
  }

  return lines.join('\n');
}
