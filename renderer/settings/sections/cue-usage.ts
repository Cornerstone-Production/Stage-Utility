// cue-usage.ts — where each cue is used, as `GET /api/cues/usage` answers it.
//
// A Button (`cue-button`) names a cue. The server walks every view, Home and the
// containers inside them included, and lists the Buttons that name each cue. The
// Automation page reads it to put "Used on" chips on a command, to say where a
// renamed command's Buttons are, and to let Search find a command by a screen.
//
// Keyed by what the Button stores, trimmed and lower-case: for an ON/OFF pair that
// is the pair's base.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { invoke } from "../../lib/api";

/** One Button that names a cue. */
export interface CueUse {
  viewId: string;
  viewName: string;
  objectId: string;
  /** The Button's own label; empty when it draws the cue's name. */
  label: string;
  /** The Button is on Home. */
  home: boolean;
}

/** The wire answer: cue name to its Buttons. */
export type CueUsageReply = Record<string, CueUse[]>;

export const CUE_USAGE_KEY = ["cues:usage"] as const;

/**
 * The usage as a Map, which is what the page looks cues up in: a cue name comes
 * from the operator's own rules, and an object keyed by it would read
 * `constructor` off the prototype. `undefined` until the first read lands, which
 * is not the same as nothing being used: callers draw no chips until then.
 *
 * `error` is returned so a page can say the read failed instead of reading
 * every command as unused.
 */
export function useCueUsage(): { usage: ReadonlyMap<string, readonly CueUse[]> | undefined; error: unknown } {
  const { data, error } = useQuery({
    queryKey: CUE_USAGE_KEY,
    queryFn: () => invoke<CueUsageReply>("cues:usage"),
  });
  // Memoised on the answer: a new Map each render would re-run everything keyed on it.
  const usage = useMemo(() => (data ? new Map(Object.entries(data)) : undefined), [data]);
  return { usage, error };
}

/** The Buttons that name any of `names` (a cue's name and its former names), each once. */
export function usesOf(usage: ReadonlyMap<string, readonly CueUse[]> | undefined, names: readonly string[]): CueUse[] {
  if (!usage) return [];
  const seen = new Set<string>();
  const out: CueUse[] = [];
  for (const name of names) {
    for (const use of usage.get(name.trim().toLowerCase()) ?? []) {
      const key = `${use.viewId}\u0000${use.objectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(use);
    }
  }
  return out;
}

/** The screens a list of uses sits on, each once, in the order first met. Home reads as its own name. */
export function screenNames(uses: readonly CueUse[]): string[] {
  return [...new Set(uses.map((u) => u.viewName))];
}
