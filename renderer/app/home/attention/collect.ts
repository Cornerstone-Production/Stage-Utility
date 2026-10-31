// Every source's items, in the order an operator should read them.

import { ATTENTION_SOURCES } from "./sources";
import type { AttentionInput, AttentionItem } from "./types";

/** Which source an item came from: the first half of its key. */
export function sourceOf(item: AttentionItem): string {
  return item.key.slice(0, item.key.indexOf(":"));
}

/**
 * Critical before warn, then by source in table order, then by subject name.
 * Readiness keeps its own order, which is already "the order they should be
 * fixed": the comparator calls it a tie, and Array.sort is stable.
 */
export function collectAttention(input: AttentionInput): AttentionItem[] {
  const order = new Map(ATTENTION_SOURCES.map((s, i) => [s.id, i]));
  return ATTENTION_SOURCES.flatMap((s) => s.items(input)).sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    const sa = sourceOf(a);
    const sb = sourceOf(b);
    if (sa !== sb) return (order.get(sa) ?? 0) - (order.get(sb) ?? 0);
    return sa === "readiness" ? 0 : a.title.localeCompare(b.title);
  });
}
