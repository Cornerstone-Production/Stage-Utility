// A slot in the shell's chrome for the active route's own controls.
//
// That chrome is rendered once by the Shell, above the outlet, so a route cannot
// put anything in it. Home worked around that with a second row of its own below
// the header — a title row, then a nearly empty row holding one link, then the
// widgets. Two rows of chrome before any content, on the page whose whole job is
// to show as much at a glance as it can.
//
// So the shell takes actions from whichever route supplies them:
//
//   usePageActions(<Button … />, [dep]);
//
// Rendered at the right of the context bar on a desktop and of the top bar on a
// phone. A route that supplies nothing gets the chrome it always had.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface PageActionsValue {
  actions: ReactNode;
  setActions: (node: ReactNode) => void;
}

const PageActionsContext = createContext<PageActionsValue | null>(null);

export function PageActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<ReactNode>(null);
  const value = useMemo(() => ({ actions, setActions }), [actions]);
  return <PageActionsContext.Provider value={value}>{children}</PageActionsContext.Provider>;
}

/** What the header should draw. Null when the active route supplies nothing. */
export function usePageActionsSlot(): ReactNode {
  return useContext(PageActionsContext)?.actions ?? null;
}

/**
 * The slot as a component.
 *
 * So a surface OUTSIDE this provider's subtree can still host the actions by
 * being handed this element — the mobile top bar lives in SplitView, a generic
 * primitive that has no business knowing what a page action is.
 */
export function PageActionsSlot() {
  return <>{usePageActionsSlot()}</>;
}

/**
 * Put controls in the shell's chrome for as long as this component is mounted.
 *
 * CLEARS ON UNMOUNT, which is the whole reason this is an effect rather than a
 * render-time registration: navigating away from Home must take Home's buttons
 * with it, or the next page inherits an Edit control that edits nothing.
 *
 * `deps` follows the usual rule — list what the node closes over. The node
 * itself is deliberately not a dependency: a fresh element every render would
 * set state every render and never settle.
 */
export function usePageActions(node: ReactNode, deps: readonly unknown[]): void {
  const ctx = useContext(PageActionsContext);
  const set = ctx?.setActions;
  useEffect(() => {
    if (!set) return;
    set(node);
    return () => set(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, ...deps]);
}
