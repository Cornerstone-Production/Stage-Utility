// How deep an embed may go, and when it must stop.
//
// PURE, and separate from the component, because this is the part that has to be
// right: a missed cycle is not a wrong pixel, it is a render loop that takes the
// tab with it — on a wall display nobody is standing next to.
//
// Two independent limits, for two different failures:
//
//   CYCLE is correctness. A view already somewhere above this one would render
//   itself for ever. Checking the whole chain rather than the immediate parent
//   is the point: A -> B -> C -> A has no parent match anywhere in it.
//
//   DEPTH is cost. Legal, acyclic nesting still multiplies — four tiles of four
//   tiles of four tiles is sixty-four live layouts, each with its own
//   subscriptions, on hardware that is often a Raspberry Pi.

/**
 * How many views may be stacked inside one another.
 *
 * Three, which covers a producer wall of screens where one of those screens is
 * itself a multiview, and stops short of anything nobody could read.
 */
export const MAX_EMBED_DEPTH = 3;

export interface EmbedRefusal {
  reason: "cycle" | "depth";
  /** Operator-facing, and specific — a notice that says only "cannot embed"
   *  leaves somebody clicking around trying to work out which tile is at fault. */
  message: string;
}

/**
 * Why this view must not be rendered here, or null when it may be.
 *
 * @param viewId The view an embed is about to draw.
 * @param chain  The views already being drawn above it, outermost first.
 */
export function embedRefusal(viewId: string, chain: readonly string[]): EmbedRefusal | null {
  if (chain.includes(viewId)) {
    return { reason: "cycle", message: "This view is already showing further out — it cannot contain itself" };
  }
  if (chain.length >= MAX_EMBED_DEPTH) {
    return { reason: "depth", message: `Nested more than ${MAX_EMBED_DEPTH} deep` };
  }
  return null;
}

/**
 * The chain a child embed inherits.
 *
 * A new array every time. Pushing onto the parent's would make siblings see each
 * other, so the second tile in a row would refuse itself as a cycle.
 */
export function childChain(viewId: string, chain: readonly string[]): string[] {
  return [...chain, viewId];
}
