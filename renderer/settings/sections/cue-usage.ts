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

import { parseAliases } from "@main/services/cue-aliases";
import type { CueButtonUse } from "@main/services/button-ownership";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { invoke } from "../../lib/api";

/** One Button that names a cue: the server's own shape, so the two cannot drift. */
export type CueUse = CueButtonUse;

/** The wire answer: cue name to its Buttons. */
export type CueUsageReply = Record<string, CueUse[]>;

export const CUE_USAGE_KEY = ["cues:usage"] as const;

/** Where each cue is used, by cue name. A Map: a cue name is the operator's, and an object keyed by it reads `constructor` off the prototype. */
export type CueUsage = ReadonlyMap<string, readonly CueUse[]>;

const usageQuery = { queryKey: CUE_USAGE_KEY, queryFn: () => invoke<CueUsageReply>("cues:usage") };
const asUsage = (reply: CueUsageReply): CueUsage => new Map(Object.entries(reply));

/**
 * The usage, read now. Every caller that needs it outside a component (a write that has to
 * know who else presses a command, a rename repointing Buttons) comes here, and the read
 * lands in the cache the page's chips draw from.
 */
export async function fetchCueUsage(qc: QueryClient): Promise<CueUsage> {
  return asUsage(await qc.fetchQuery({ ...usageQuery, staleTime: 0 }));
}

/**
 * The usage as a Map, which is what the page looks cues up in: a cue name comes
 * from the operator's own rules, and an object keyed by it would read
 * `constructor` off the prototype. `undefined` until the first read lands, which
 * is not the same as nothing being used: callers draw no chips until then.
 *
 * `error` is returned so a page can say the read failed instead of reading
 * every command as unused.
 */
export function useCueUsage(): { usage: CueUsage | undefined; error: unknown } {
  const { data, error } = useQuery(usageQuery);
  // Memoised on the answer: a new Map each render would re-run everything keyed on it.
  const usage = useMemo(() => (data ? asUsage(data) : undefined), [data]);
  return { usage, error };
}

/** The Buttons that name any of `names` (a cue's name and its former names), each once. */
export function usesOf(usage: CueUsage | undefined, names: readonly string[]): CueUse[] {
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

interface HasTrigger {
  trigger: { params: Record<string, string | number> };
}

/**
 * Every name a Button may hold for a command, which is what "where it is used" looks up.
 *
 * ONE definition, for the list's Used on chips and for the rule editor's places, so the
 * row and the dialog cannot disagree about where a command is used. A single command is
 * its own name and its former names. A pair is its base, both halves' names, and BOTH
 * halves' former names: a Button stores the pair's base and may name either half, and an
 * old half name is still a name that resolves.
 */
export function namesFor(
  of: { rule: HasTrigger } | { pair: { base: string; onName: string; offName: string; on: HasTrigger; off: HasTrigger } },
): string[] {
  if ("rule" in of) return [String(of.rule.trigger.params.name ?? ""), ...parseAliases(of.rule.trigger.params)];
  const { base, onName, offName, on, off } = of.pair;
  return [base, onName, offName, ...parseAliases(on.trigger.params), ...parseAliases(off.trigger.params)];
}
