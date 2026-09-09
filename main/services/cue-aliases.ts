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
 * How many former names one cue keeps.
 *
 * Bounded because it is unbounded growth otherwise: a button somebody relabels
 * every week would accumulate a name per week forever, all of them live URLs.
 * Five is enough to cover the pasted YAML an operator has not got round to
 * refreshing, and the oldest falls off first.
 */
export const MAX_ALIASES = 5;

/** The former names in a cue's trigger params, in order, oldest first. */
export function parseAliases(params: Record<string, string | number>): string[] {
  const seen = new Set<string>();
  for (const part of String(params.aliases ?? "").split(",")) {
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
