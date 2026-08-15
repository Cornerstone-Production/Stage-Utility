// Where every object actually lands, for a given viewport.
//
// Replaces `fill`. That mode was not a transform stretch — objects are fractions
// and fonts are fractions of the live window height, so text never distorted —
// but proportional reflow was the whole of its responsiveness. A square tile
// became a wide rectangle, a row of three across became three slivers on a tall
// window, and a console built on a laptop was unusable on a phone.
//
// Four mechanisms, smallest first. Each is optional and OFF by default, so a
// layout that sets none of them lays out exactly as it does today — which is the
// property that lets this ship without touching a single existing view.
//
//   1. anchors      — pin an edge instead of drifting proportionally
//   2. keepAspect   — scale evenly inside the space rather than stretching
//   3. min/max px   — a control cannot shrink below tappable or balloon on 4K
//   4. stacking     — a genuinely different shape reflows into one column
//
// Pure: viewport in, pixels out. The editor and the kiosk call the same function,
// so they cannot disagree about where anything is.

/** How far the viewport's aspect may stray from the design's before stacking.
 *  A log-ratio, so it is symmetric: 0.5 is roughly "half or double the shape". */
const STACK_ASPECT_DEVIATION = 0.5;

/** Below this width, stack regardless of aspect — a phone is a phone. */
const STACK_MAX_WIDTH = 500;

export interface Viewport { w: number; h: number }

export interface PlacedObject {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

type Anchor = { x?: "left" | "right" | "center"; y?: "top" | "bottom" | "center" };

interface Responsive {
  anchor?: Anchor;
  keepAspect?: boolean;
  minPx?: { w?: number; h?: number };
  maxPx?: { w?: number; h?: number };
}

/** Whether this viewport is different enough from the design to rearrange.
 *  Exported because the editor's preview needs to show the same decision. */
export function shouldStack(canvas: { width: number; height: number }, vp: Viewport): boolean {
  if (vp.w <= 0 || vp.h <= 0) return false;
  if (vp.w < STACK_MAX_WIDTH) return true;
  const deviation = Math.abs(Math.log((vp.w / vp.h) / (canvas.width / canvas.height)));
  return deviation > STACK_ASPECT_DEVIATION;
}

function clampSize(v: number, min?: number, max?: number): number {
  let out = v;
  if (min != null) out = Math.max(out, min);
  if (max != null) out = Math.min(out, max);
  return out;
}

/**
 * Place one object inside a box, in pixels.
 *
 * `box` is the parent's pixel rect — the viewport for a top-level object, or the
 * container's own rect for a child. That is what keeps nesting working: a child
 * is placed within its container, never against the window.
 */
function place(
  o: LayoutObject,
  box: { left: number; top: number; w: number; h: number },
  canvas: { width: number; height: number },
  /** The box's size in DESIGN pixels — the canvas for a top-level object, the
   *  container's design size for a child. Anchors hold a distance measured
   *  here, which is what makes them anchors: a gap held as a fraction of the
   *  live box is just proportional reflow wearing a different name. */
  design: { w: number; h: number },
): PlacedObject {
  const r = (o as unknown as Responsive);
  let width = o.w * box.w;
  let height = o.h * box.h;

  if (r.keepAspect) {
    // The shape the object was DESIGNED at, in real terms.
    const designRatio = (o.w * canvas.width) / (o.h * canvas.height);
    if (width / height > designRatio) width = height * designRatio;
    else height = width / designRatio;
  }

  width = clampSize(width, r.minPx?.w, r.maxPx?.w);
  height = clampSize(height, r.minPx?.h, r.maxPx?.h);

  // Unanchored is proportional — today's behaviour, and the default.
  let left = box.left + o.x * box.w;
  let top = box.top + o.y * box.h;

  if (r.anchor?.x === "right") {
    // Hold the design's distance from the right edge, in pixels.
    const gapPx = (1 - o.x - o.w) * design.w;
    left = box.left + box.w - gapPx - width;
  } else if (r.anchor?.x === "center") {
    left = box.left + (box.w - width) / 2;
  }

  if (r.anchor?.y === "bottom") {
    const gapPx = (1 - o.y - o.h) * design.h;
    top = box.top + box.h - gapPx - height;
  } else if (r.anchor?.y === "center") {
    top = box.top + (box.h - height) / 2;
  }

  return { id: o.id, left, top, width, height };
}

/** Reading order: top to bottom, then left to right. NOT z order — z is paint
 *  order and says nothing about what should come first when read. */
function readingOrder(objects: readonly LayoutObject[]): LayoutObject[] {
  return [...objects].sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/**
 * Every object's pixel rect for this viewport, containers and children alike.
 *
 * Children are returned alongside their parents, flattened, because the caller
 * positions absolutely and does not need the tree.
 */
export function resolveLayout(
  objects: readonly LayoutObject[],
  canvas: { width: number; height: number },
  vp: Viewport,
): PlacedObject[] {
  const out: PlacedObject[] = [];

  const walk = (
    list: readonly LayoutObject[],
    box: { left: number; top: number; w: number; h: number },
    design: { w: number; h: number },
  ) => {
    for (const o of list) {
      const p = place(o, box, canvas, design);
      out.push(p);
      if (o.children?.length) {
        // A child's design box is its parent's design box scaled by the child's
        // fractions, so anchors nest correctly.
        walk(
          o.children,
          { left: p.left, top: p.top, w: p.width, h: p.height },
          { w: o.w * design.w, h: o.h * design.h },
        );
      }
    }
  };

  if (shouldStack(canvas, vp)) {
    // One column, in reading order, each object a band. Containers keep their
    // children, laid out inside the band rather than against the window.
    const PAD = Math.round(Math.min(vp.w, vp.h) * 0.02);
    const GAP = Math.round(PAD * 0.6);
    const top = readingOrder(objects);
    const bandH = top.length
      ? Math.max(24, (vp.h - PAD * 2 - GAP * (top.length - 1)) / top.length)
      : 0;
    let y = PAD;
    for (const o of top) {
      const box = { left: PAD, top: y, w: vp.w - PAD * 2, h: bandH };
      out.push({ id: o.id, left: box.left, top: box.top, width: box.w, height: box.h });
      if (o.children?.length) walk(o.children, box, { w: o.w * canvas.width, h: o.h * canvas.height });
      y += bandH + GAP;
    }
    return out;
  }

  walk(objects, { left: 0, top: 0, w: vp.w, h: vp.h }, { w: canvas.width, h: canvas.height });
  return out;
}
