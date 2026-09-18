// prefs.ts — which series and figures a section shows, remembered.
//
// Every one of these is a per-BROWSER view preference: which lines a person
// wants on screen and which figures they want in the strip. None of them is a
// recording setting, and none of them should reach another operator's screen.
//
// The SPL metric list used to be the exception — it lived in
// settingsStore.splVisibleMetrics, server-wide — so one person clicking a legend
// entry changed what everybody saw. It is a localStorage entry now, SEEDED once
// from the server value (seedStoredKeys) so nobody's existing selection is lost
// in the move.

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Who wants to know when a stored key list changes.
 *
 * localStorage fires `storage` only in OTHER tabs, so two components in ONE tab
 * reading the same entry never heard about each other's writes. That is not
 * theoretical: the Sound card owns the Smaart metric choice, and the service
 * header's "Peak <metric>" figure reads the same entry — switching metric in
 * Customize relabelled the card and left the header quoting the old metric's
 * level until the page was reopened.
 */
const listeners = new Map<string, Set<() => void>>();

/** Tell everyone reading `storageKey` that it changed. */
function notifyStoredKeys(storageKey: string): void {
  for (const fn of listeners.get(storageKey) ?? []) fn();
}

/** Listen for writes to `storageKey` from anywhere in this tab. */
export function subscribeStoredKeys(storageKey: string, fn: () => void): () => void {
  let set = listeners.get(storageKey);
  if (!set) listeners.set(storageKey, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(storageKey);
  };
}

/**
 * A counter that increments whenever `storageKey` is written.
 *
 * For a reader that does not own the choice and only needs to recompute when it
 * changes — the service header's peak-level figure reads the metric list
 * through a plain function, not through `useStoredKeys`, and needs something to
 * put in a `useMemo` dependency list.
 */
export function useStoredKeysVersion(storageKey: string): number {
  const [n, setN] = useState(0);
  useEffect(() => subscribeStoredKeys(storageKey, () => setN((v) => v + 1)), [storageKey]);
  return n;
}

/** True when this browser has a stored choice at all — as opposed to an EMPTY
 *  one, which is a real choice and reads back as `[]`. Callers that offer a
 *  default only to a browser that has never chosen ask this. */
export function hasStoredChoice(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) != null;
  } catch {
    return false;
  }
}

/** Write a starting choice, but only into a browser that has never made one.
 *  Seeds a per-browser preference from the server-side setting it is taking
 *  over from, so nobody's existing selection is lost in the move. */
export function seedStoredKeys(storageKey: string, keys: string[]): void {
  try {
    if (localStorage.getItem(storageKey) != null) return;
    localStorage.setItem(storageKey, JSON.stringify(keys));
  } catch {
    // Private mode or a full quota. The browser simply takes the defaults.
  }
}

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
export function readStoredKeys(
  storageKey: string,
  /** The keys still on offer, or null for "anything the operator stored".
   *
   *  null matters for a list whose offering is PER RECORD: the Smaart metrics
   *  one service carries are not the ones another does, and filtering against
   *  the record on screen would quietly drop every metric the current service
   *  happens not to have, the next time the choice was written. */
  allowed: readonly string[] | null,
  fallback: string[],
): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const clean = parsed.filter((k): k is string => typeof k === "string" && (allowed == null || allowed.includes(k)));
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
  allowed: readonly string[] | null,
  fallback: string[],
): [string[], (key: string) => Error | null, () => void] {
  const [keys, setKeys] = useState<string[]>(() => readStoredKeys(storageKey, allowed, fallback));
  const toggle = useCallback(
    (key: string): Error | null => {
      const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
      setKeys(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
        // Everything else in this tab reading the same entry, including this
        // hook mounted a second time elsewhere on the page. Announced AFTER the
        // write so a listener re-reading sees the new value.
        notifyStoredKeys(storageKey);
        return null;
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      }
    },
    [keys, storageKey],
  );

  /** The current `allowed`/`fallback`, for the subscription below. Both are
   *  fresh arrays every render, so neither can be a dependency without
   *  rebuilding the subscription on every one of them. Written in an effect
   *  rather than during render — a ref assigned while rendering is a tear the
   *  linter is right to refuse. */
  const latest = useRef({ allowed, fallback });
  useEffect(() => {
    latest.current = { allowed, fallback };
  });
  // Another component wrote this entry — re-read, so two strips on one page
  // cannot disagree about what is ticked. The writer's own `setKeys` above has
  // already run; this lands on an equal list for it and changes nothing.
  useEffect(
    () =>
      subscribeStoredKeys(storageKey, () => {
        setKeys(readStoredKeys(storageKey, latest.current.allowed, latest.current.fallback));
      }),
    [storageKey],
  );
  /**
   * Re-read the store.
   *
   * For the one case where something else writes it after this hook has already
   * initialised: a seed arriving from the server (seedStoredKeys). Without it
   * the seeded choice does not appear until the page is opened again, so the
   * first visit after the preference moved shows the defaults instead of the
   * operator's actual selection — the exact thing the seed exists to prevent.
   */
  const reload = useCallback(() => {
    setKeys(readStoredKeys(storageKey, allowed, fallback));
    // `allowed` and `fallback` are fresh arrays on every render, so they are
    // deliberately NOT dependencies: including them would rebuild `reload` each
    // render and re-fire any effect that depends on it, forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  return [keys, toggle, reload];
}
