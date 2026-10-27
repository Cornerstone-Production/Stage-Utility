// cue-aliases.ts — the former names a cue still answers to.
//
// PURE: no I/O, no engine. The settings page imports it to render "was <old>",
// so nothing here may reach for a file or a socket.
//
// A cue name is not decoration. It is the URL Home Assistant calls
// (`rest_command.su_<name>`), and the HomeKit switch a household asks for was
// created from that command — so renaming a cue breaks the switch until somebody
// re-pastes the generated YAML into configuration.yaml and reloads. That is a
// job for a Tuesday, not for the moment a button gets relabelled.
//
// So a rename keeps the old name as an ALIAS: `POST /api/cues/<former name>`
// still resolves to the cue, and the switch keeps working until the operator
// gets round to re-pasting. The engine treats a name and a former name as one
// namespace — no rule may take either from another rule — because a former name
// that somebody else could claim is a switch that silently starts driving a
// different projector.
//
// STORED COMMA-JOINED in `trigger.params.aliases`, because `Rule.trigger.params`
// is `Record<string, string | number>` — the same reason `actionIds` is joined
// rather than the type being widened for one field. This module is the only
// place that knows the encoding.

/**
 * The trigger id that makes a rule a cue.
 *
 * Lives in this PURE module rather than in the trigger registry because the
 * settings page needs it: automation-triggers.ts imports spl-recorder for its
 * metric list, which reaches `node:url`, so a renderer module that pulled the
 * registry in for one string crashed the whole app at load with
 * "fileURLToPath is not a function" and an empty page. Re-exported from
 * automation-triggers.ts, so every existing import site is unchanged.
 */
export const CALL_TRIGGER_ID = "call.by-name";

/**
 * How many former names one cue keeps.
 *
 * Bounded because it is unbounded growth otherwise: a button somebody relabels
 * every week would accumulate a name per week forever, all of them live URLs.
 * Five is enough to cover the pasted YAML an operator has not got round to
 * refreshing, and the oldest falls off first.
 */
export const MAX_ALIASES = 5;

/**
 * The cue name a rule answers to, normalised the way the engine compares it, or ""
 * when the rule is not a cue.
 */
export function calledCueName(trigger: { id: string; params: Record<string, string | number> }): string {
  return trigger.id === CALL_TRIGGER_ID ? String(trigger.params?.name ?? "").trim().toLowerCase() : "";
}

/**
 * Every cue name in use, with its former names, and the built-ins — what a new
 * cue's name must not be. The engine treats them as ONE namespace.
 */
export function takenCueNames(
  rules: readonly { trigger: { id: string; params: Record<string, string | number> } }[],
  reserved: Iterable<string> = [],
): Set<string> {
  const taken = new Set([...reserved].map((n) => n.toLowerCase()));
  for (const r of rules) {
    const name = calledCueName(r.trigger);
    if (name) taken.add(name);
    if (r.trigger.id === CALL_TRIGGER_ID) for (const alias of parseAliases(r.trigger.params)) taken.add(alias);
  }
  return taken;
}

/** The former names in a cue's trigger params, in order, oldest first. Params a
 *  hand-edited rules file left out are none, so one bad cue cannot throw inside
 *  every other cue's name check. */
export function parseAliases(params: Record<string, string | number> | undefined): string[] {
  const seen = new Set<string>();
  for (const part of String(params?.aliases ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    if (name) seen.add(name);
  }
  return [...seen];
}

/** The stored form. "" for none, so the key can be written rather than deleted. */
export function encodeAliases(aliases: readonly string[]): string {
  return aliases.join(",");
}

/**
 * The alias list after a rename from `oldName` to `newName`.
 *
 * `newName` is REMOVED from the list, not just skipped: renaming a cue back to a
 * name it used to have would otherwise leave it holding its own name as a former
 * name, which the engine refuses to save — a rename that threw where it should
 * have been a no-op.
 */
export function nextAliases(
  existing: readonly string[],
  oldName: string,
  newName: string,
): string[] {
  const kept = existing.filter((a) => a !== oldName && a !== newName);
  return [...kept, oldName].slice(-MAX_ALIASES);
}
