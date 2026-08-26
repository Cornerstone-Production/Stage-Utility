// The lines drawn while an object snaps to another.
//
// Decoration only: no pointer events, no state. Everything it needs is in the
// Guide list that alignRect already returned, so the lines cannot disagree with
// where the object actually landed — they are computed from the same result.

import type { Guide } from "./alignment";

const pct = (v: number) => `${v * 100}%`;

export function AlignmentGuides({ guides }: { guides: readonly Guide[] }) {
  if (!guides.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-50" aria-hidden="true">
      {guides.map((g, i) => {
        // A guide spans only the objects it relates, so it reads as "these two
        // line up" rather than as a full-canvas ruler that happens to pass through.
        const style =
          g.axis === "x"
            ? { left: pct(g.at), top: pct(g.span.from), height: pct(g.span.to - g.span.from), width: 1 }
            : { top: pct(g.at), left: pct(g.span.from), width: pct(g.span.to - g.span.from), height: 1 };
        return (
          <div
            key={`${g.axis}-${g.at}-${i}`}
            className="absolute"
            style={{
              ...style,
              // A guide lands exactly ON the edge it marks — usually another object's
              // border or the container drop highlight, both of which are drawn in the
              // accent. Painted in the accent itself it was invisible: verified in a
              // browser, where the element was present, opaque and correctly placed and
              // still could not be picked out from the chrome underneath it.
              //
              // A light tint separates it from that chrome while staying correct under
              // a themed accent, and the dark halo keeps it legible over a bright object.
              background: "color-mix(in srgb, var(--su-accent), white 55%)",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.55)",
            }}
          />
        );
      })}
    </div>
  );
}
