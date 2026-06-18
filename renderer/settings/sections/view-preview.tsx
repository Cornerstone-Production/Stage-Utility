import { useEffect, useRef, useState } from "react";

const DESIGN_W = 1280;

/**
 * A live, non-interactive thumbnail of a View. Runs the real kiosk renderers in
 * an <iframe> pointed at the `/preview-<viewId>` route (resolved straight from
 * the View, regardless of routing), rendered at a fixed design width and scaled
 * to fit the container. `aspect` (width ÷ height) shapes the box so it mirrors
 * the target monitor — e.g. 16/9 for a 37″ panel.
 */
export function ViewPreview({ viewId, aspect = 16 / 9 }: { viewId: string; aspect?: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  const designH = Math.round(DESIGN_W / aspect);

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
      style={{ aspectRatio: `${DESIGN_W} / ${designH}` }}
    >
      <iframe
        key={`${viewId}:${designH}`}
        src={`/preview-${encodeURIComponent(viewId)}`}
        title="View preview"
        tabIndex={-1}
        style={{
          width: DESIGN_W,
          height: designH,
          border: 0,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
