// prefs.ts — which series and figures a section shows, remembered.
//
// The chip rows persisted to two different places and this keeps both, rather
// than migrating an operator's choices to a third: attendance to localStorage
// (a per-browser view preference), and the SPL metric list to the server
// (settingsStore.splVisibleMetrics, through spl:get/setVisibleMetrics). The
// Customize popover is a new control over the SAME stores, so nobody's existing
// selection is lost by this change.

import { useCallback, useState } from "react";

/**
 * Read a stored key list, dropping anything no longer offered.
 *
 * `fallback` when nothing is stored or the value is unreadable. NOT when every
 * stored key has since been removed — that lands on the empty list, exactly as
 * an operator who unticked everything does, because the two are the same state
 * and there is nothing in the store that tells them apart. (An earlier version
 * of this comment claimed the all-removed case fell back; it never did, and
 * saying so invited a change that would spring every default back on.)
 */
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
 * Add a key to a stored selection ONCE, and remember that it was added.
 *
 * A new default reaches nobody who already has a stored selection: the stored
 * list wins, and it cannot contain a key that did not exist when it was written.
 * `average` landed exactly there — every operator with a chip selection from
 * before this release would never have seen it.
 *
 * ONCE is the whole point. Adding it on every load would undo the operator's
 * untick the next time they opened the page, which is worse than never offering
 * it. The marker is a separate entry rather than a version number on the list,
 * so a hand-edited or cleared selection does not re-run it.
 *
 * Returns nothing and throws nothing: a browser that refuses to write simply
 * does not get the new default, which is the state it was already in.
 */
export function addDefaultOnce(storageKey: string, key: string): void {
  const marker = `${storageKey}:added:${key}`;
  try {
    if (localStorage.getItem(marker)) return;
    localStorage.setItem(marker, "1");
    const raw = localStorage.getItem(storageKey);
    // Nothing stored = this browser takes the DEFAULTS, which already carry the
    // key. Writing a list here would freeze today's defaults for them forever.
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const keys = parsed.filter((k): k is string => typeof k === "string");
    if (keys.includes(key)) return;
    localStorage.setItem(storageKey, JSON.stringify([...keys, key]));
  } catch {
    // Private mode, a full quota, a hostile profile. The operator keeps the
    // selection they had; nothing is lost and nothing is silently rewritten.
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
