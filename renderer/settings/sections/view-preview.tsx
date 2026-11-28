import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn";
import { useLatestRef } from "@renderer/lib/use-latest-ref";
import { previewSrc } from "@renderer/main/preview-url";
import { PREVIEW_MSG, readPreviewMessage, sendPreviewMessage } from "@renderer/main/preview-messages";
import { useLivenessProbe, type LivenessProbe } from "./use-liveness-probe";

const DESIGN_W = 1280;

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
  outputId = null,
  aspect = 16 / 9,
  draftSlots = null,
  bleed = false,
  liveness,
}: {
  viewId: string;
  /**
   * The Output this preview is STANDING IN FOR, when it is standing in for one.
   *
   * The route is `/preview-<viewId>` — a View, not a screen — so without this the
   * iframe cannot know which of the screens showing that View it is a picture of,
   * and per-screen settings have nothing to resolve against. Two screens can show
   * one View with the top bar hidden on only one of them.
   *
   * Rides in the query rather than the path: the path segment IS the view id
   * (`preview-` is a reserved slug prefix, see reserved-slugs.ts), and a second
   * segment would be a second thing for every reader of that slug to parse. The
   * kiosk already reads a legacy `?display=` this way.
   *
   * Null on a preview that is not a screen — the View editor's own preview, and
   * the "not on a screen" card, neither of which has an Output to speak for.
   */
  outputId?: string | null;
  aspect?: number;
  draftSlots?: Slot[] | null;
  /**
   * Edge to edge inside whatever frames it: no side border and no corner radius,
   * so the container's own border and radius are the preview's sides. The top and
   * bottom rules stay, as the seam against the header above and the footer below.
   * The Screens cards use it; the View editor's own preview keeps its rounded box.
   */
  bleed?: boolean;
  /**
   * Whether the page inside is live, for a Screens card: see use-liveness-probe.ts
   * and preview-messages.ts. The View editor's own preview does not ask.
   */
  liveness?: LivenessProbe;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0.25);
  const designH = Math.round(DESIGN_W / aspect);

  // Latest draft in a ref so the ready-handshake handler always posts current data.
  const draftRef = useLatestRef(draftSlots);
  const onProbeLoad = useLivenessProbe(iframeRef, viewId, liveness);

  function postDraft(target: Window | null | undefined) {
    sendPreviewMessage(target, { type: PREVIEW_MSG.DRAFT, viewId, slots: draftRef.current });
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
      const m = readPreviewMessage(e, iframeRef.current?.contentWindow, viewId);
      if (m?.type === PREVIEW_MSG.READY) postDraft(iframeRef.current?.contentWindow);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId]);

  return (
    <div
      ref={boxRef}
      className={cn(
        "relative isolate w-full overflow-hidden border border-gray-a4 bg-black",
        bleed ? "border-x-0" : "rounded-xl",
      )}
      style={{
        aspectRatio: `${DESIGN_W} / ${designH}`,
        // The iframe is scaled with a transform, which puts it on its own compositor
        // layer, and `overflow: hidden` with a radius does not reliably clip such a
        // layer: the frame's own square corners showed through the rounded box. A
        // clip-path does clip it. 0.75rem is `rounded-xl`, the radius above. A bleed
        // preview has no radius, so there is nothing to clip.
        clipPath: bleed ? undefined : "inset(0 round 0.75rem)",
      }}
    >
      <iframe
        ref={iframeRef}
        key={`${viewId}:${designH}`}
        // The output id is part of the address, so it survives a reload and needs
        // no handshake — but it is NOT in the key above, because it never changes
        // for a given card. What the flag it resolves is set to changes all the
        // time; that arrives inside the iframe over the state stream, and hiding
        // a screen's top bar must not cost the card an iframe reload.
        src={previewSrc(viewId, outputId)}
        title="View preview"
        tabIndex={-1}
        onLoad={() => {
          postDraft(iframeRef.current?.contentWindow);
          onProbeLoad();
        }}
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
