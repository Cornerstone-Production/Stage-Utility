// prefs.ts — which series and figures a section shows, remembered.
//
// The chip rows persisted to two different places and this keeps both, rather
// than migrating an operator's choices to a third: attendance to localStorage
// (a per-browser view preference), and the SPL metric list to the server
// (settingsStore.splVisibleMetrics, through spl:get/setVisibleMetrics). The
// Customize popover is a new control over the SAME stores, so nobody's existing
// selection is lost by this change.

import { useCallback, useState } from "react";

/** Read a stored key list, dropping anything no longer offered. Returns
 *  `fallback` when nothing is stored, when the JSON is unreadable, or when every
 *  stored key has since been removed. */
export function readStoredKeys(storageKey: string, allowed: readonly string[], fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const clean = parsed.filter((k): k is string => typeof k === "string" && allowed.includes(k));
    // An EMPTY stored list is a real choice — "show me no figures" — and is kept.
    // It is only an unreadable or absent value that falls back.
    return clean;
  } catch {
    return fallback;
  }
}

/**
 * A ticked-key set backed by localStorage.
 *
 * Returns the write failure rather than swallowing it: a browser in private mode
 * throws on setItem, and a Customize popover that silently forgets every choice
 * is worse than one that says it could not remember.
 */
export function useStoredKeys(
  storageKey: string,
  allowed: readonly string[],
  fallback: string[],
): [string[], (key: string) => Error | null] {
  const [keys, setKeys] = useState<string[]>(() => readStoredKeys(storageKey, allowed, fallback));
  const toggle = useCallback(
    (key: string): Error | null => {
      const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
      setKeys(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
        return null;
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    },
    [keys, storageKey],
  );
  return [keys, toggle];
}
