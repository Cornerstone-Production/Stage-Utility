import { useState } from "react";

/**
 * Run `reset` during render on mount and whenever any of `deps` changes,
 * including the render in which it changed. Dependencies are compared like
 * `useEffect`'s, so the call reads the same way the effect it replaces did.
 *
 * A value that must NOT be read at mount — a clock skew measured from a
 * replayed frame — belongs in a hook that keys on change only, see
 * use-server-skew.ts.
 *
 * This replaces the `useEffect(() => setX(...), [prop])` shape used to mirror a
 * prop or a server value into local state. That shape renders twice for every
 * change — once with the stale state, then again once the effect fires — so a
 * stage display briefly paints the previous value. Adjusting state during render
 * is React's documented answer: the re-render happens before the browser paints,
 * so the stale frame never reaches the screen.
 *
 * Use it only for state that genuinely has to persist between changes — a draft
 * being edited, a retry counter. State that is purely a function of props needs
 * no state at all; derive it, or memo it.
 *
 * ```ts
 * useResyncOn([slot.photoUrl], () => {
 *   setImgAttempt(0);
 *   setImgFailed(false);
 * });
 * ```
 */
export function useResyncOn(deps: readonly unknown[], reset: () => void): void {
  // `null` until the first render has run `reset`. The effect this replaces ran
  // on mount, and so must this: seeding `last` with the mount-time deps instead
  // meant a component that mounted with its source already in hand (the slot
  // editor opened from Screens, stage state already cached) never mirrored it,
  // and showed nothing until a refresh happened to mount it mid-load.
  const [last, setLast] = useState<readonly unknown[] | null>(null);
  if (last === null || deps.length !== last.length || deps.some((d, i) => !Object.is(d, last[i]))) {
    setLast(deps);
    reset();
  }
}
