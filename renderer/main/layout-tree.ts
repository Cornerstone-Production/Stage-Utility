// Pure, immutable helpers for the nested-object layout tree.
//
// A layout is a forest of `LayoutObject`s. Top-level objects are positioned as
// fractions of the CANVAS; a container's `children` are positioned as fractions
// of that container's box. These helpers never mutate in place — every update
// returns new arrays/objects along the changed path (structural sharing), which
// is what makes the editor's snapshot-based undo correct.

/** A rect in fractions (0..1). Used both for parent-local coords and, after the
 *  ancestor fold, for absolute canvas-space coords. */
export interface FracRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Depth-first search for an object by id, anywhere in the tree. */
export function findById(nodes: LayoutObject[], id: string | null): LayoutObject | null {
  if (!id) return null;
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children?.length) {
      const hit = findById(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Return a new tree with `fn` applied to the node matching `id` (others kept by
 *  reference). Recurses into children so nested nodes update too. */
export function mapById(
  nodes: LayoutObject[],
  id: string,
  fn: (o: LayoutObject) => LayoutObject,
): LayoutObject[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (n.children?.length) {
      const next = mapById(n.children, id, fn);
      if (next !== n.children) return { ...n, children: next };
    }
    return n;
  });
}

/** Remove the node with `id` from anywhere in the tree. Returns the new tree and
 *  the removed node (or null if not found). */
export function removeById(
  nodes: LayoutObject[],
  id: string,
): { tree: LayoutObject[]; removed: LayoutObject | null } {
  let removed: LayoutObject | null = null;
  const walk = (list: LayoutObject[]): LayoutObject[] => {
    const out: LayoutObject[] = [];
    for (const n of list) {
      if (n.id === id) {
        removed = n;
        continue;
      }
      if (n.children?.length) {
        const next = walk(n.children);
        out.push(next === n.children ? n : { ...n, children: next });
      } else {
        out.push(n);
      }
    }
    return out;
  };
  const tree = walk(nodes);
  return { tree, removed };
}

/** The parent of `id`, or null if `id` is top-level (or absent). */
export function getParentOf(nodes: LayoutObject[], id: string): LayoutObject | null {
  for (const n of nodes) {
    if (n.children?.some((c) => c.id === id)) return n;
    if (n.children?.length) {
      const hit = getParentOf(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** The sibling array containing `id` — a container's `children` or the top-level
 *  array. Falls back to the top-level array. */
export function getSiblings(nodes: LayoutObject[], id: string): LayoutObject[] {
  const parent = getParentOf(nodes, id);
  return parent?.children ?? nodes;
}

/** Insert `child` into the container with `parentId`'s children (returns a new tree). */
export function insertChild(
  nodes: LayoutObject[],
  parentId: string,
  child: LayoutObject,
): LayoutObject[] {
  return mapById(nodes, parentId, (p) => ({ ...p, children: [...(p.children ?? []), child] }));
}

/** Nesting depth of `id` (top-level = 0, child = 1, grandchild = 2, …). */
export function depthOf(nodes: LayoutObject[], id: string, depth = 0): number {
  for (const n of nodes) {
    if (n.id === id) return depth;
    if (n.children?.length) {
      const d = depthOf(n.children, id, depth + 1);
      if (d >= 0) return d;
    }
  }
  return -1;
}

/** Compose a child's parent-local rect with its parent's absolute rect to get the
 *  child's absolute (canvas-space) rect. All in fractions. */
export function composeRect(parentAbs: FracRect, local: FracRect): FracRect {
  return {
    x: parentAbs.x + local.x * parentAbs.w,
    y: parentAbs.y + local.y * parentAbs.h,
    w: parentAbs.w * local.w,
    h: parentAbs.h * local.h,
  };
}

/** Inverse of composeRect: express an absolute rect as a fraction of `parentAbs`. */
export function localizeRect(parentAbs: FracRect, abs: FracRect): FracRect {
  return {
    x: (abs.x - parentAbs.x) / parentAbs.w,
    y: (abs.y - parentAbs.y) / parentAbs.h,
    w: abs.w / parentAbs.w,
    h: abs.h / parentAbs.h,
  };
}

export interface RectWalkNode {
  o: LayoutObject;
  /** Absolute canvas-space rect (fractions). */
  abs: FracRect;
  /** Absolute rect of this node's parent (the canvas for top-level). */
  parentAbs: FracRect;
  depth: number;
}

const CANVAS_RECT: FracRect = { x: 0, y: 0, w: 1, h: 1 };

/** Walk the tree (parents before children), yielding each node with its absolute
 *  canvas-space rect and its parent's absolute rect. Composition is done in
 *  fractions to avoid px rounding drift. */
export function forEachWithRect(
  nodes: LayoutObject[],
  visit: (n: RectWalkNode) => void,
  parentAbs: FracRect = CANVAS_RECT,
  depth = 0,
): void {
  for (const o of nodes) {
    const abs = depth === 0 ? { x: o.x, y: o.y, w: o.w, h: o.h } : composeRect(parentAbs, o);
    visit({ o, abs, parentAbs, depth });
    if (o.children?.length) forEachWithRect(o.children, visit, abs, depth + 1);
  }
}

/** Deep-clone an object (and its whole subtree), minting a fresh id at every
 *  depth via `uid`. Copies `style`/`config`/`children` so no references are shared
 *  with the source — required when duplicating objects or loading templates. */
export function deepCloneFreshIds(o: LayoutObject, uid: () => string): LayoutObject {
  return {
    ...o,
    id: uid(),
    style: o.style ? { ...o.style } : undefined,
    config: { ...o.config },
    children: o.children?.map((c) => deepCloneFreshIds(c, uid)),
  };
}
