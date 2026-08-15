// Seeing the layout on a window that is not the design's shape, without leaving
// the editor.
//
// Phase 4 built the responsive model and the inspector that configures it, but
// the only way to see the result was to open the display and drag the window
// about. An operator configuring an anchor could not see what the anchor did.
//
// The preview renders the REAL LayoutRenderer — the same component the kiosk
// mounts — inside a box sized to the exact viewport in CSS pixels, then scales
// that box down to fit the editor. LayoutRenderer measures itself with
// clientWidth/clientHeight, which a CSS transform does not affect, so it sees
// the true viewport (390x844) while the operator sees it at whatever size fits.
//
// That is the whole trick, and it is why the editor and the kiosk cannot
// disagree about where an object lands: there is one implementation, not two.

import { LayoutRenderer } from "../main/layout-renderer";
import { shouldStack } from "../main/responsive-layout";
import { fitFor } from "../main/console-fit";
import type { ViewSurface } from "@main/types/views";

export interface PreviewShape {
  id: string;
  label: string;
  /** Viewport in CSS pixels. Null means "the design canvas itself". */
  vp: { w: number; h: number } | null;
}

/**
 * The shapes offered.
 *
 * Four, not twelve: a switcher long enough to need scrolling is one nobody uses.
 * Design is first and is the only editable one — everything else is read-only,
 * because editing at a shape the layout is not stored in would mean writing back
 * geometry the operator did not mean to change.
 */
export const PREVIEW_SHAPES: PreviewShape[] = [
  { id: "design", label: "Design", vp: null },
  { id: "panel", label: "Panel", vp: { w: 1024, h: 768 } },
  { id: "phone", label: "Phone", vp: { w: 390, h: 844 } },
  { id: "ultrawide", label: "Ultrawide", vp: { w: 3840, h: 1080 } },
];

export function ShapePreview({
  shape,
  layout,
  ndiSource,
  surface,
  avail,
}: {
  shape: PreviewShape;
  layout: LayoutDTO;
  ndiSource: string | null;
  surface: ViewSurface;
  /** Space the editor has for the canvas, in rendered pixels. */
  avail: { w: number; h: number };
}) {
  const vp = shape.vp;
  if (!vp) return null;

  const scale =
    avail.w > 0 && avail.h > 0 ? Math.min(avail.w / vp.w, avail.h / vp.h, 1) : 0;

  // shouldStack describes the VIEWPORT; it says nothing about whether this layout
  // reflows. A letterboxed wall screen keeps its arrangement at every shape, and
  // the first version of this caption announced "stacked into one column" over a
  // preview that was plainly letterboxed — caught by looking at it.
  const responsive = fitFor({ surface }, layout.canvas.fit) === "responsive";
  const stacks = responsive && shouldStack(layout.canvas, vp);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <div
        // The OUTER box is the on-screen footprint, so the flex parent lays this
        // out at its scaled size rather than reserving 3840px for an ultrawide.
        style={{ width: vp.w * scale, height: vp.h * scale }}
        className="relative overflow-hidden rounded-md ring-1 ring-line-strong"
      >
        <div
          style={{
            width: vp.w,
            height: vp.h,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          {/* interactive={false}: a preview must never fire a control. The Screens
              page learned this the hard way — every card renders one, and a live
              preview would let looking at the page advance the service. */}
          <LayoutRenderer
            layout={layout}
            ndiSource={ndiSource}
            interactive={false}
            surface={surface}
          />
        </div>
      </div>

      <p className="max-w-prose text-center text-caption2 text-fg-muted">
        {vp.w} &times; {vp.h}
        {" — "}
        <span className="text-fg">
          {!responsive
            ? "letterboxed: this layout keeps the design's shape exactly, on every screen"
            : stacks
              ? "stacked into one column, because this shape is too different from the design to keep the arrangement"
              : "reflowed to fit, keeping the arrangement"}
        </span>
      </p>
    </div>
  );
}
