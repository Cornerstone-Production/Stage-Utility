import { useEffect, useRef, useState } from "react";

const DESIGN_W = 1280;
const DESIGN_H = 720;

/**
 * A live, non-interactive thumbnail of a View. Runs the real kiosk renderers in
 * an <iframe> pointed at the `/preview-<viewId>` route (resolved straight from
 * the View, regardless of routing), rendered at a fixed design size and scaled
 * to fit the container width.
 */
export function ViewPreview({ viewId }: { viewId: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => {
      const w = box.clientWidth;
      if (w > 0) setScale(w / DESIGN_W);
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={boxRef}
      className="relative w-full overflow-hidden rounded-xl border border-gray-a4 bg-black"
      style={{ aspectRatio: `${DESIGN_W} / ${DESIGN_H}` }}
    >
      <iframe
        key={viewId}
        src={`/preview-${encodeURIComponent(viewId)}`}
        title="View preview"
        tabIndex={-1}
        style={{
          width: DESIGN_W,
          height: DESIGN_H,
          border: 0,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
