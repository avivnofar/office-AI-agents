/**
 * front-localization — closes the capability CAPABILITY-TOOLBOX.md listed as
 * `UNSUPPLIED` against Agent 9 since 2026-08-10 (plan 6.2).
 *
 * THE DIRECTION, because it is easy to get backwards: `hebrew_composition`
 * (workers/gap-reports.js, workers/meeting-engine.js) WRITES Hebrew, in an
 * agent's own voice, for internal office material. Nothing before this file
 * carried content the other way. This module is that other direction: it
 * reads a real Hebrew artifact the office already produced and re-voices it
 * into English for the public Front. It is NOT hebrew_composition run
 * backwards and it is NOT a thin translation wrapper — see
 * `config/model-routing.json`'s `front_localization` lane for why it is a
 * separate lane rather than a parameter on the existing one.
 *
 * RE-VOICING, NOT TRANSLATION. The Front's narrative, in the owner's own
 * words (OB-013, note 2, 2026-08-11): "a team of AI agents that takes
 * complex tasks and executes them with hierarchy, policy and office logic,
 * and that reviews itself and improves autonomously." A literal translation
 * of an internal Hebrew gap note reads like a translated internal note. The
 * prompt below asks for the same voice and the same facts, restated as
 * fluent English narrative a visitor would actually read — never inventing
 * an outcome, a number or a fact the source did not contain.
 *
 * This module has NO PRODUCTION CALLER yet, deliberately — the same
 * "reachable but no production consumer" shape CAPABILITY-TOOLBOX.md already
 * records for `semantic-search`. OB-013's structure proposal is the future
 * caller (front-drafts content for pages sourced from internal Hebrew
 * material — gap digests, meeting minutes, report summaries); this session
 * builds and proves the lane, not the Front page that will call it, per the
 * session's own hard rule against writing Front content.
 */

import { routeTaskTypeCall } from './model-router.js';

export const FRONT_LOCALIZATION_TASK_TYPE = 'front_localization';

function buildSystemPrompt({ agentName, sourceKind }) {
  return [
    "You are the office's English voice for its public-facing website.",
    `You are re-voicing an internal Hebrew ${sourceKind || 'note'}, written by ${agentName || 'an office agent'}, into English for a visitor who has never seen the internal material.`,
    'RE-VOICE. DO NOT TRANSLATE. The output must read as fluent, natural English narrative that a visitor would actually want to read — never a sentence that reads like it started in another language, and never a word-for-word rendering.',
    'Carry every real fact, number and conclusion from the source across faithfully. Never invent a fact, a number, an outcome or a level of certainty the source does not contain.',
    'If part of the source is unclear, garbled, or an error message rather than real content, say so plainly in the English output rather than smoothing it into something that sounds more finished than the source actually was.',
    "Keep the agent's own first-person voice and the office's tone — direct, unembellished, comfortable naming a problem.",
    'Output English only. No Hebrew characters. No preamble, no explanation of the task — only the re-voiced text itself.',
  ].join('\n');
}

export function buildLocalizationPrompt(hebrewText) {
  return `Internal Hebrew material to re-voice into English for the public Front:\n\n${hebrewText}`;
}

/**
 * Re-voices one real Hebrew artifact into English. Returns both texts so a
 * caller (or a supervised test) can show the pair rather than only the
 * output — the proof this capability needs is the comparison, not the
 * English alone.
 *
 * `sourceKind` names what the artifact IS (e.g. "capability-gap note",
 * "meeting-minute summary") — it shapes the system prompt but is never
 * itself translated or invented.
 */
export async function localizeForFront(env, hebrewText, {
  agentName = null,
  sourceKind = null,
  eventId = null,
  maxTokens = 500,
} = {}) {
  const source = String(hebrewText || '').trim();
  if (!source) {
    return { ok: false, reason: 'empty_source_text' };
  }

  const call = await routeTaskTypeCall(env, FRONT_LOCALIZATION_TASK_TYPE, {
    prompt: buildLocalizationPrompt(source),
    systemPrompt: buildSystemPrompt({ agentName, sourceKind }),
    maxTokens,
    eventId: eventId || `front_localization:${agentName || 'unknown'}`,
  });

  if (!call.ok || !String(call.result?.text || '').trim()) {
    return {
      ok: false,
      reason: call.reason || 'localization_call_failed',
      attempts: call.attempts || [],
      provider: call.provider || null,
      sourceText: source,
    };
  }

  return {
    ok: true,
    lane: FRONT_LOCALIZATION_TASK_TYPE,
    provider: call.provider,
    agentName,
    sourceKind,
    sourceText: source,
    englishText: call.result.text.trim(),
  };
}
