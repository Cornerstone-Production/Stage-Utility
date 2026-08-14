// The join an operator used to hold in their head.
//
// Views and Displays were separate tabs: one listed content, the other listed
// screens, and answering "what is that screen showing, and is it even on?"
// meant reading both and pairing them yourself. This does the pairing.
//
// Pure, so the awkward cases — an output pointing at a View that no longer
// exists, an output with nothing assigned — are testable without rendering.

export interface ScreenRow {
  outputId: string;
  name: string;
  /** Friendly URL if set, else the id. What to open to see this screen. */
  path: string;
  /** The View it shows, or null when nothing is assigned. */
  viewName: string | null;
  viewId: string | null;
  /** True when the assigned View no longer exists — a dangling reference. */
  missingView: boolean;
  online: boolean;
  /** Only a custom-kind View has a layout to edit. */
  editableLayout: boolean;
}

export function screenRows(
  state: StageState,
  onlineOutputIds: readonly string[],
): ScreenRow[] {
  const online = new Set(onlineOutputIds);
  const views = new Map((state.views ?? []).map((v) => [v.id, v]));

  return (state.outputs ?? []).map((o) => {
    const view = o.viewId ? views.get(o.viewId) : undefined;
    return {
      outputId: o.id,
      name: o.name,
      path: o.slug || o.id,
      viewId: o.viewId ?? null,
      // null, not "" — "no view" and "a view named nothing" must not render
      // identically, and a dangling id must not read as an empty name.
      viewName: view?.name ?? null,
      missingView: !!o.viewId && !view,
      online: online.has(o.id),
      editableLayout: view?.kind === "custom",
    };
  });
}
