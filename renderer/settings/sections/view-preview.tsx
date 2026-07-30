import { useEffect, useRef, useState } from "react";
import { useLatestRef } from "@renderer/lib/use-latest-ref";

const DESIGN_W = 1280;

// Messages exchanged with the preview iframe (same-origin only).
const DRAFT_MSG = "stage-utility:preview-draft";
const READY_MSG = "stage-utility:preview-ready";

/**
 * A live, non-interactive thumbnail of a View. Runs the real kiosk renderers in
 * an <iframe> pointed at the `/preview-<viewId>` route (resolved straight from
 * the View, regardless of routing), rendered at a fixed design width and scaled
 * to fit the container. `aspect` (width ÷ height) shapes the box so it mirrors
 * the target monitor — e.g. 16/9 for a 37″ panel.
 *
 * `draftSlots` (when set) are pushed into the iframe via postMessage so the
 * preview reflects UNSAVED slot edits live. Null clears the draft, so the iframe
 * falls back to the saved server state. The iframe announces readiness with a
 * `preview-ready` message; we (re)post the current draft in response, so drafts
 * survive the iframe remounting on view/aspect changes.
 */
export function ViewPreview({
  viewId,
  aspect = 16 / 9,
  draftSlots = null,
}: {
  viewId: string;
  aspect?: number;
  draftSlots?: Slot[] | null;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0.25);
  const designH = Math.round(DESIGN_W / aspect);

  // Latest draft in a ref so the ready-handshake handler always posts current data.
  const draftRef = useLatestRef(draftSlots);

  function postDraft(target: Window | null | undefined) {
    if (!target) return;
    target.postMessage({ type: DRAFT_MSG, viewId, slots: draftRef.current }, window.location.origin);
  }

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

  // Push the draft into the iframe whenever it changes (best-effort; the ready
  // handshake below guarantees delivery for a freshly (re)loaded iframe).
  useEffect(() => {
    postDraft(iframeRef.current?.contentWindow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSlots, viewId]);

  // The preview app posts "ready" once its listener is attached — reply with the
  // current draft so edits made before it mounted still land.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; viewId?: string } | null;
      if (data?.type === READY_MSG && data.viewId === viewId) {
        postDraft(iframeRef.current?.contentWindow);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId]);

  return (
    <div
      ref={boxRef}
      className="relative w-full overflow-hidden rounded-xl border border-gray-a4 bg-black"
      style={{ aspectRatio: `${DESIGN_W} / ${designH}` }}
    >
      <iframe
        ref={iframeRef}
        key={`${viewId}:${designH}`}
        src={`/preview-${encodeURIComponent(viewId)}`}
        title="View preview"
        tabIndex={-1}
        onLoad={() => postDraft(iframeRef.current?.contentWindow)}
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
