// A dismissed dialog is never consent to throw work away — including work that
// the dialog itself does not hold.
//
// The integration dialog compares its own form against the saved config to know
// whether it is dirty. That comparison cannot see a sub-panel: RossTslFeedsPanel
// and ProPresenterInstancesPanel each buffer a list of rows in their own
// useState behind an explicit "Save feeds" / "Save instances" button, and
// neither `feeds` nor `instances` is in the descriptor's configSchema. The
// dialog is keyed on the integration id, so dismissing it unmounted the panel
// and the buffer went with it: add an instance, type a name and an address,
// press Escape, and it was gone with no question asked.
//
// So a panel reports upward instead. It registers "I have unsaved work, and
// here is how to save it"; the dialog folds that into its own `dirty`, and the
// confirm's "Save & close" runs the panel's save before it closes.

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

/** One panel's unsaved buffer, and the save that would land it. */
export interface UnsavedWork {
  /** Persist the buffer. Resolves false if the save failed — the caller must
   *  not close on a false, exactly as the dialog's own save must not. */
  save: () => Promise<boolean>;
}

/** What a panel reports into. Opaque to callers; pass it to UnsavedWorkProvider. */
export interface UnsavedWorkRegistry {
  report: (id: string, work: UnsavedWork | null) => void;
}

const UnsavedWorkContext = createContext<UnsavedWorkRegistry | null>(null);

/**
 * The host side: the live set of sub-panels holding unsaved work.
 *
 * `dirty` is true while any registered panel holds a buffer; `saveAll()` lands
 * every one of them and returns false if any refused.
 */
export function useUnsavedWork(): {
  dirty: boolean;
  saveAll: () => Promise<boolean>;
  registry: UnsavedWorkRegistry;
} {
  const [ids, setIds] = useState<readonly string[]>([]);
  // The save callbacks live in a ref, not in state: they close over the panel's
  // latest rows and so change identity on every keystroke, and holding them in
  // state would re-render the whole dialog for each one.
  const works = useRef(new Map<string, UnsavedWork>());

  const report = useCallback((id: string, work: UnsavedWork | null) => {
    if (work === null) works.current.delete(id);
    else works.current.set(id, work);
    setIds((prev) => {
      const has = prev.includes(id);
      if (work === null) return has ? prev.filter((x) => x !== id) : prev;
      return has ? prev : [...prev, id];
    });
  }, []);

  const registry = useMemo<UnsavedWorkRegistry>(() => ({ report }), [report]);

  const saveAll = useCallback(async () => {
    let ok = true;
    // Sequential, not Promise.all: two panels of the same integration both POST
    // to the same /config route, and the loser of that race would overwrite the
    // winner's response with a state that predates it.
    for (const work of [...works.current.values()]) {
      if (!(await work.save())) ok = false;
    }
    return ok;
  }, []);

  return { dirty: ids.length > 0, saveAll, registry };
}

export function UnsavedWorkProvider({
  registry,
  children,
}: {
  registry: UnsavedWorkRegistry;
  children: ReactNode;
}): ReactNode {
  return <UnsavedWorkContext.Provider value={registry}>{children}</UnsavedWorkContext.Provider>;
}

/**
 * The panel side: tell whatever dialog is hosting us that we hold unsaved work.
 *
 * A no-op outside a provider, so a panel still renders standalone.
 *
 * @param id     stable per panel instance — the registry keys on it.
 * @param dirty  whether the panel's buffer differs from what is saved.
 * @param save   lands the buffer; resolves false if the save failed.
 */
export function useReportUnsavedWork(
  id: string,
  dirty: boolean,
  save: () => Promise<boolean>,
): void {
  const registry = useContext(UnsavedWorkContext);
  // Read the latest save through a ref so a re-render of the panel does not
  // churn the registration — only `dirty` flipping does.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    registry?.report(id, dirty ? { save: () => saveRef.current() } : null);
  }, [registry, id, dirty]);

  // Deregister on unmount only. Deps are stable, so this does not run when
  // `dirty` flips — the effect above already re-reports for that.
  useEffect(() => () => registry?.report(id, null), [registry, id]);
}
