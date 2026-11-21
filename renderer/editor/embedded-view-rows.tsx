// embedded-view-rows.tsx — the Embedded view object's rows in the inspector.
//
// Its own component, apart from the inspector, which needs a stack of live integration
// hooks to mount: what the rows offer is decided here, and a test can render them.

import type { LayoutObjectConfig, ViewKind } from "@main/types/stage";
import { flashTarget, VIEW_LAYOUT_FLASH_ID } from "../app/flash";
import { cn } from "../lib/cn";
import { INLINE_LINK } from "../lib/link-classes";
import { useServiceCueLayouts } from "../lib/use-servicecue-layouts";
import { useInAppLink } from "../lib/use-search-param";
import { isOfferableInEmbedPicker } from "../main/layout-objects";
import { KIND_LABELS } from "../settings/sections/view-kinds";
import { RowSelect, RowSwitch } from "./inspector-rows";

type EmbedConfig = Extract<LayoutObjectConfig, { type: "view-embed" }>;

/** What the rows read of a view. */
export interface EmbedViewRef {
  id: string;
  name: string;
  kind: ViewKind;
  serviceCueLayoutId?: string | null;
}

export function EmbeddedViewRows({
  c,
  onConfig,
  hostViewId,
  views,
}: {
  c: EmbedConfig;
  onConfig: (c: LayoutObjectConfig) => void;
  /** The view whose layout is being edited: never offered to itself. */
  hostViewId: string;
  views: readonly EmbedViewRef[];
}) {
  const go = useInAppLink();
  const embeddable = views.filter((v) => isOfferableInEmbedPicker(v.kind) && v.id !== hostViewId);
  const picked = views.find((v) => v.id === c.viewId);
  // "Show the view's header" and "Follow the live item" act on a ServiceCue view only. Their
  // saved values stay in the layout when they are hidden, and apply again if it is switched back.
  const isServiceCue = picked?.kind === "script";
  const read = useServiceCueLayouts(isServiceCue, { tag: "layout-editor", what: "the ServiceCue layouts for an embedded view" });
  const layouts = read.layouts;

  if (embeddable.length === 0) {
    return <p className="text-caption2 text-fg-muted">No other views yet — make one, then point this at it.</p>;
  }

  const layoutLine = (() => {
    if (!picked || !isServiceCue) return null;
    const to = `/screens/${picked.id}/edit`;
    const layout = picked.serviceCueLayoutId ? layouts?.find((l) => l.id === picked.serviceCueLayoutId) : undefined;
    // Nothing is said while the read is in flight; only a read that failed says so.
    const says = read.failed
      ? "Couldn't read this view's layout"
      : layouts === null
        ? null
        : layout
          ? <>Shows the <b className="font-semibold text-fg">{layout.name}</b> layout</>
          : <>Shows <b className="font-semibold text-fg">All columns</b></>;
    return (
      <p className="text-caption2 text-fg-muted">
        {says}{says && " ·"}{" "}
        <a
          href={to}
          onClick={(e) => {
            go(e, { to });
            // Only when the router took the click: a new tab has its own page to land on.
            if (e.defaultPrevented) flashTarget(VIEW_LAYOUT_FLASH_ID);
          }}
          className={cn(INLINE_LINK, "font-medium")}
        >
          Change
        </a>
      </p>
    );
  })();

  return (
    <>
      <RowSelect
        label="View"
        hint="Renders that view's content here, natively. Dashboard, stage and SPL-rundown views are configured per screen, not per view — pick an Embedded screen for those instead. A view cannot contain itself, and nesting stops after three levels."
        description={layoutLine}
        value={c.viewId ?? ""}
        options={[
          { value: "", label: "None" },
          ...embeddable.map((v) => ({ value: v.id, label: `${v.name} (${KIND_LABELS[v.kind]})` })),
          // An embed saved pointing at its own view: never offered, but named, so the select shows
          // what is wrong rather than the bare id the select would fall back to. Stored data is
          // untouched; picking anything else replaces it.
          ...(c.viewId && c.viewId === hostViewId ? [{ value: c.viewId, label: `${picked?.name ?? c.viewId} · can't contain itself` }] : []),
        ]}
        onChange={(v) => onConfig({ ...c, viewId: v || null })}
      />
      {isServiceCue && (
        <>
          <RowSwitch label="Show the view's header" checked={c.showHeader ?? false} onChange={(v) => onConfig({ ...c, showHeader: v })} />
          <RowSwitch
            label="Follow the live item"
            hint="Scrolls the rundown to keep Planning Center's live item on screen, so a service that runs past the bottom of the box does not need anyone to touch the display. Only ever scrolls this object, never the rest of the layout. Turn off for a box parked on the top of the plan."
            checked={c.autoScroll ?? true}
            onChange={(v) => onConfig({ ...c, autoScroll: v })}
          />
        </>
      )}
    </>
  );
}
