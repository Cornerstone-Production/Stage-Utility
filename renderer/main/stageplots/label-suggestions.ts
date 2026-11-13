// label-suggestions.ts — what the label field offers: labels already used in
// this venue (the plot being edited, unsaved changes included, and the venue's
// other plots), then starter gear, filtered as you type.

import type { PlotItem } from "@main/types/stageplots";

/** Gear most plots carry, offered after the venue's own labels. */
export const STARTER_LABELS = [
  "Drum kit",
  "Grand piano",
  "Keyboard",
  "Floor wedge",
  "Guitar amp",
  "Bass amp",
  "Mic stand",
  "FOH console",
  "Speaker",
  "Camera",
  "DI box",
  "Stage box",
  "IEM transmitter",
] as const;

/**
 * The labels this venue already uses, de-duplicated and sorted: every labelled
 * item that is not text, across `plots` (the draft first), leaving out the item
 * being labelled so its own half-typed label is not offered back.
 */
export function venueLabels(plots: readonly (readonly PlotItem[])[], exceptId: string | null): string[] {
  const seen = new Set<string>();
  for (const items of plots) for (const it of items) if (it.id !== exceptId && it.type !== "text" && it.label.trim()) seen.add(it.label);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export interface Suggestions {
  venue: string[];
  starter: string[];
}

/**
 * The two groups for `query`: everything when it is empty (the field just took
 * focus), otherwise the labels containing it, case-insensitively. Starter gear
 * already used in the venue is listed once, under the venue.
 */
export function labelSuggestions(used: readonly string[], query: string): Suggestions {
  const q = query.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const usedSet = new Set(used);
  return { venue: used.filter(hit), starter: STARTER_LABELS.filter((s) => !usedSet.has(s) && hit(s)) };
}
