// unsaved-guard.tsx — do not lose an edit because somebody clicked a tab.
//
// The signage editors work on a DRAFT so a half-made change never reaches a
// wall, which is right — and it meant switching tab silently threw the draft
// away. There was no warning and no undo; the work was just gone, and the only
// clue was the field being back to what it had been.
//
// So a section registers what it is holding, and the tabs ask before leaving.
// A context rather than props threaded through four sections: the thing asking
// (the tab strip) and the thing that knows (the editor) are not adjacent, and
// passing a dirty flag up through every section is how one of them comes to
// forget.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ask } from "../../components/ui/confirm-dialog";

interface Pending {
  /** What is unsaved, named for the question: "Save the changes to Foyer loop?" */
  what: string;
  save: () => Promise<void>;
  discard: () => void;
}

interface GuardValue {
  /** Called by an editor whenever its draft appears or clears. */
  register: (pending: Pending | null) => void;
  /** True when something is unsaved right now. */
  dirty: boolean;
  /**
   * Ask, if there is anything to ask about. Resolves false to stay put.
   *
   * Three answers, not two: Save, Discard, and Cancel. A two-button prompt makes
   * "I clicked the wrong tab" cost you the work either way.
   */
  confirmLeave: () => Promise<boolean>;
}

const GuardContext = createContext<GuardValue | null>(null);

export function UnsavedGuardProvider({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState(false);
  // A ref as well as state: confirmLeave must read the CURRENT pending edit, and
  // a callback closing over state would ask about whatever was there when the
  // tab strip last rendered.
  const pendingRef = useRef<Pending | null>(null);

  const register = useCallback((pending: Pending | null) => {
    pendingRef.current = pending;
    setDirty(pending !== null);
  }, []);

  const confirmLeave = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return true;

    const answer = await ask({
      title: `Save the changes to ${pending.what}?`,
      message: "Leaving without saving throws them away.",
      confirmLabel: "Save",
      // The third answer. Without it, "I clicked the wrong tab" costs the work
      // whichever button you press.
      denyLabel: "Discard",
      cancelLabel: "Stay here",
    });

    if (answer === "cancel") return false;
    if (answer === "confirm") {
      try {
        await pending.save();
      } catch {
        // A failed save must not then also discard. Stay put with the edit
        // intact — the editor has already said what went wrong.
        return false;
      }
    } else {
      pending.discard();
    }
    register(null);
    return true;
  }, [register]);

  // A hard reload or a closed tab, which no in-app prompt can intercept. The
  // browser's own dialog is ugly and unstyleable; it is also the only thing
  // that works here, and losing an edit silently is worse than an ugly dialog.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Assigning returnValue is what actually triggers the prompt in Chromium;
      // preventDefault alone is the spec and is not enough in practice.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const value = useMemo(() => ({ register, dirty, confirmLeave }), [register, dirty, confirmLeave]);
  return <GuardContext.Provider value={value}>{children}</GuardContext.Provider>;
}

/** For the tab strip: ask before leaving. */
export function useUnsavedGuard(): GuardValue {
  return (
    useContext(GuardContext) ?? {
      // Outside a provider nothing is guarded, which is the honest default for a
      // section rendered somewhere else — rather than throwing and taking the
      // page down over a prompt.
      register: () => {},
      dirty: false,
      confirmLeave: async () => true,
    }
  );
}

/**
 * For an editor: say what is unsaved, and how to save or throw it away.
 *
 * `pending` must be MEMOISED by the caller, keyed on its draft — this registers
 * whatever it is given, and an object rebuilt every render would re-register on
 * every keystroke. Held that way rather than through a ref: reading a ref inside
 * an effect to keep handlers current is exactly what React's rules forbid, and
 * the memo says the same thing without the trick.
 *
 * Cleared on unmount, so an editor cannot leave a stale claim behind.
 */
export function useRegisterUnsaved(pending: Pending | null): void {
  const { register } = useUnsavedGuard();
  useEffect(() => {
    register(pending);
    return () => register(null);
  }, [pending, register]);
}
