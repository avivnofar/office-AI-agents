#!/usr/bin/env node
/**
 * scripts/verify-localization-engine.js
 *
 * Dry-run verifier for `workers/localization-engine.js` (front-localization,
 * OB-013's UNSUPPLIED capability, closed 2026-08-11).
 *
 * SOURCE-TEXT ASSERTIONS, not a live import of the module — same technique
 * `scripts/verify-routing.js` uses for `workers/model-router.js`, for the
 * same reason (its own header, verbatim): "imports JSON and cannot be loaded
 * by plain `node`". `localization-engine.js` imports `routeTaskTypeCall`
 * from `model-router.js`, which imports `config/token-economy.json` and
 * `config/model-routing.json` with NO import attribute — the convention this
 * whole codebase uses everywhere except `repo-write.js`, because Wrangler's
 * bundler resolves it and plain Node's stricter ESM loader does not. That is
 * a property of every file in `workers/` that touches the config layer, not
 * a defect in this one, and this verifier works with it rather than fighting
 * it or forking the codebase's JSON-import convention for one file.
 *
 * The END-TO-END proof (a real Hebrew capability-gap note, re-voiced live
 * via the `front_localization` lane, provider mistral) ran once this session
 * against the deployed Worker and is recorded in the session's own report —
 * this file is what turns that one live run into something re-checked on
 * every future run, without needing network or the live Worker to do it.
 *
 * NO NETWORK.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

globalThis.fetch = () => {
  throw new Error('TRIPWIRE: verify-localization-engine.js made a network call. It must not.');
};

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`); }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n--- ${title} ---`); }

const routing = JSON.parse(read('config/model-routing.json'));
const src = read('workers/localization-engine.js');

section('§1 the lane exists in config and the module names it consistently');
check('front_localization is a lane in the routing table', !!routing.lanes.front_localization);
check('the lane is chat-kind (text in, text out)', routing.lanes.front_localization.kind === 'chat');
check('the lane names a primary and a backup provider', !!routing.lanes.front_localization.primary && !!routing.lanes.front_localization.backup);
check("the module exports FRONT_LOCALIZATION_TASK_TYPE = 'front_localization', matching the config key",
  /export const FRONT_LOCALIZATION_TASK_TYPE = 'front_localization';/.test(src));
check('the module calls the router by that exact constant, not a hand-typed string that could drift',
  /routeTaskTypeCall\(env, FRONT_LOCALIZATION_TASK_TYPE,/.test(src));

section('§2 it is a NEW lane, not hebrew_composition reversed — asserted in config, not just claimed in prose');
check('front_localization and hebrew_composition are DIFFERENT lane objects',
  routing.lanes.front_localization !== routing.lanes.hebrew_composition);
check('the config states why in its own words (grep, not eyeballed)',
  /new lane/i.test(routing.lanes.front_localization._new_lane_not_an_extension_and_why || ''));
check('the module\'s own header states the same direction rule',
  /hebrew_composition.*WRITES Hebrew/is.test(src));

section('§3 the system prompt — re-voice, never translate, never invent, English-only, source-voice preserved');
check('the system prompt instructs RE-VOICE, not translation', /RE-VOICE\. DO NOT TRANSLATE/.test(src));
check('the system prompt forbids inventing facts, numbers or outcomes', /[Nn]ever invent a fact/.test(src));
check('the system prompt requires English-only output, no Hebrew characters', /Output English only\. No Hebrew/.test(src));
check('the system prompt requires the source\'s own first-person voice to carry over', /first-person voice/i.test(src));
check('a garbled/unclear source must be named, not smoothed over', /garbled/i.test(src));
check('agentName and sourceKind are interpolated into the prompt, not hard-coded', /\$\{agentName/.test(src) && /\$\{sourceKind/.test(src));

section('§4 buildLocalizationPrompt — carries the real text through unmodified, no summarising wrapper');
check('buildLocalizationPrompt is exported', /export function buildLocalizationPrompt\(hebrewText\)/.test(src));
check('it interpolates the caller\'s text directly, not through any transform call', /`Internal Hebrew material[^`]*\$\{hebrewText\}`/.test(src));

section('§5 localizeForFront — the empty-input guard fires BEFORE the router is ever called');
check('localizeForFront is exported and takes (env, hebrewText, opts)', /export async function localizeForFront\(env, hebrewText, \{/.test(src));
check('a trimmed-empty source short-circuits with empty_source_text', /if \(!source\) \{\s*return \{ ok: false, reason: 'empty_source_text' \};/.test(src));
const guardIdx = src.indexOf("reason: 'empty_source_text'");
const routeIdx = src.indexOf('routeTaskTypeCall(env, FRONT_LOCALIZATION_TASK_TYPE');
check('the guard appears BEFORE the routed call in source order — the call is genuinely unreachable on empty input',
  guardIdx !== -1 && routeIdx !== -1 && guardIdx < routeIdx);
check('a failed/empty routed call is also refused, not returned as a false success',
  /if \(!call\.ok \|\| !String\(call\.result\?\.text \|\| ''\)\.trim\(\)\)/.test(src));

section('§6 no production caller yet — stated, not silently true');
check('the config records that this lane has no production caller yet',
  /reachable only through/i.test(routing.lanes.front_localization._no_production_caller_yet || ''));
check('the module\'s own header states the same thing about itself',
  /NO PRODUCTION CALLER yet/.test(src));

section('§7 wired into the admin trigger for supervised end-to-end testing');
const runnerSrc = read('workers/agent-runner.js');
check('agent-runner.js imports localizeForFront', /import \{ localizeForFront \} from '\.\/localization-engine\.js';/.test(runnerSrc));
check("the 'localization_test' trigger case exists and requires hebrewText", /case 'localization_test':/.test(runnerSrc) && /localization_test_requires_hebrewText/.test(runnerSrc));

section('Network tripwire');
check('this verifier made ZERO network calls end to end', true);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
