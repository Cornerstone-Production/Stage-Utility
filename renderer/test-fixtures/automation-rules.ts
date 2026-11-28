// automation-rules.ts — one builder for the automation rules renderer tests feed
// a stubbed /api/automation/rules.
//
// Thirteen test files each declared their own `StubRule` interface, a second copy
// of `Rule`, and the copies had already drifted (`conditions: never[]` in one,
// `{ id, params }[]` in another, string-only params in a third). The builder is typed
// from the real `Rule`, so a field added to or renamed on it fails the compile here
// instead of leaving a test serving a rule shape the server no longer sends.
//
//   const cue = (name: string): Rule => rule({ name, trigger: { id: "call.by-name", params: { name } } });
//
// TEST-ONLY: no `.test.` in the filename, so `npm test`'s glob skips it. Type-only
// import, so it binds to nothing at load.

import type { Rule } from "@main/types/automation";

/** A rule that fires nothing special: a Called-by-name trigger and a log line, enabled, no cooldown. */
export function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: "rule-1",
    name: "Rule",
    enabled: true,
    trigger: { id: "call.by-name", params: { name: "cue_name" } },
    conditions: [],
    action: { id: "log.message", params: {} },
    cooldownSec: 0,
    oncePerService: false,
    ...over,
  };
}
