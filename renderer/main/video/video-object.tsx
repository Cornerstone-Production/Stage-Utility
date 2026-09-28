// renderer/main/video/video-object.tsx — the Video widget: presentation only.
// Playback choice, WebRTC/HLS/embed session management, retry backoff and
// every timer live in use-video-session.ts; this file decides WHAT TO SHOW
// for a phase and wires the DOM (the <video> element, on-screen gating, the
// preview pause) around it.
//
// Always muted, no controls: video only, never audio, and nothing on a stage
// display for anyone to scrub or pause.

import { useCallback, useMemo, useRef, useState, type ErrorInfo } from "react";

import { BrandLogo } from "../../components/brand-logo";
import { ErrorBoundary } from "../../components/ui/error-boundary-view";
import { logToServer } from "../../lib/client-log";
import { errorMessage } from "@main/services/errors";
import { isPreviewSlug } from "../preview-url";
import { useOnScreen } from "./use-on-screen";
import { useVideoSession } from "./use-video-session";
import { useVideoState } from "./use-video-state";

const HIDDEN_TEARDOWN_MS = 3000;

/** What the "N s behind" badge (top left) and the name tag (bottom left)
 *  share: the corner, and type that scales with the widget's own width. */
const CORNER_LABEL = {
  left: 8,
  fontSize: "clamp(9px, 1.3cqw, 13px)",
  lineHeight: "clamp(11px, 1.6cqw, 15px)",
  padding: "clamp(2px, 0.4cqw, 4px) clamp(4px, 0.7cqw, 8px)",
  borderRadius: 4,
} as const;

type VideoObjectConfig = Extract<LayoutObjectConfig, { type: "video" }>;

function isPreviewRoute(): boolean {
  return isPreviewSlug(window.location.pathname.slice(1));
}

/**
 * The shared ErrorBoundary, plus a `[video]` log line on the way to its
 * fallback — silent in the base class, which is right for a route boundary
 * but wrong for a widget an operator has no other way of hearing failed.
 */
class VideoErrorBoundary extends ErrorBoundary {
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logToServer("video", `widget crashed: ${errorMessage(error)}`);
    super.componentDidCatch(error, info);
  }
}

/**
 * `appLogo`/`appLogoMonochrome` are named fields, not `ctx={ctx}` — this file
 * lives outside layout-renderer.tsx, and gate-render-parity.test.ts resolves a
 * component handed the WHOLE ctx by looking for it as a top-level function
 * INSIDE that file. Naming exactly the two fields this widget reads (the
 * offline-logo state) keeps the reads visible in the switch arm's own source
 * text instead of failing that scan or silently escaping it.
 */
export function VideoObject({
  o,
  config,
  appLogo,
  appLogoMonochrome,
}: {
  o: LayoutObject;
  config: VideoObjectConfig;
  appLogo: string | null;
  appLogoMonochrome: boolean;
}) {
  return (
    // Keyed on the feed id: a different feed (or one disappearing) is a clean
    // remount — of the boundary itself, so a crash on one feed does not stay
    // wedged forever once the operator points the object at a working one —
    // and a verdict about the PREVIOUS feed's WebRTC support, or a pending
    // backoff timer, can never carry onto the next feed either.
    <VideoErrorBoundary key={config.feedId ?? "none"} fallback={<CantPlayBody name="This feed" />}>
      <VideoObjectBody objectId={o.id} config={config} appLogo={appLogo} appLogoMonochrome={appLogoMonochrome} />
    </VideoErrorBoundary>
  );
}

function VideoObjectBody({
  objectId,
  config,
  appLogo,
  appLogoMonochrome,
}: {
  objectId: string;
  config: VideoObjectConfig;
  appLogo: string | null;
  appLogoMonochrome: boolean;
}) {
  const state = useVideoState();
  const feed = useMemo(
    () => (config.feedId && state ? (state.feeds.find((f) => f.id === config.feedId) ?? null) : null),
    [state, config.feedId],
  );
  // A feedId that names nothing in a LOADED feed list: the feed was deleted.
  // Before the list has loaded, feed is also null — indistinguishable from
  // deleted, so this stays false until `state` actually answers.
  const feedDeleted = !!config.feedId && !!state && !feed;

  const containerRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(containerRef, HIDDEN_TEARDOWN_MS);

  // A STATE value, not a plain ref: see use-video-session.ts's VideoSessionInput
  // doc for why the session effect needs to see the element APPEAR, not just
  // read a ref that mutated silently underneath it.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

  const [previewPaused, setPreviewPaused] = useState(isPreviewRoute);
  const onLog = useCallback((reason: string) => logToServer("video", reason), []);

  const { phase, embedUrl, latency } = useVideoSession({
    active: onScreen && !previewPaused,
    feed,
    feedDeleted,
    video: videoEl,
    allowHls: true, // Always on until a screen has its own "Use HLS on this screen" switch.
    onLog,
  });

  const name = feed?.name ?? "This feed";
  const isEmbed = embedUrl !== null;
  const showingPicture = phase === "live" || phase === "delayed";
  const showLabel = config.showLabel !== false;
  const showTag = showLabel && !previewPaused && (isEmbed || showingPicture);

  if (!config.feedId) {
    return (
      <div className="flex items-center justify-center w-full h-full" style={{ color: "rgba(255,255,255,0.3)" }}>
        Choose a feed
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-video-object={objectId}
      className="relative w-full h-full bg-black overflow-hidden"
      style={{ containerType: "inline-size" }}
    >
      {previewPaused ? (
        <PreviewPausedBody name={name} onPlay={() => setPreviewPaused(false)} />
      ) : (
        <>
          {!isEmbed && (
            <video
              ref={setVideoEl}
              muted
              playsInline
              autoPlay
              disablePictureInPicture
              className="absolute inset-0 w-full h-full"
              style={{ objectFit: config.fit ?? "contain" }}
            />
          )}
          {isEmbed && (
            <iframe
              src={embedUrl}
              allow="autoplay; encrypted-media"
              referrerPolicy="strict-origin-when-cross-origin"
              style={{ border: 0, width: "100%", height: "100%", pointerEvents: "none" }}
            />
          )}
          {/* An OPAQUE cover, never `opacity: 0` on the <video> itself: an
              invisible-but-still-"visible" video may never fire
              requestVideoFrameCallback in every browser, which would time
              every attempt out before a frame had a chance to arrive. Omitted
              entirely for "nothing": the approved design's offline-nothing
              state is transparent over the box, not a covered one with empty
              content. */}
          {!isEmbed && !showingPicture && !(phase === "offline" && config.whenOffline === "nothing") && (
            <div className="absolute inset-0" style={{ background: "var(--kiosk-bg)" }}>
              {phase === "waiting" && <StateText big="Waiting for the source" small="Nothing is sending to this feed yet" />}
              {phase === "connecting" && <ConnectingBody name={name} />}
              {phase === "offline" && <OfflineBody mode={config.whenOffline ?? "message"} name={name} appLogo={appLogo} appLogoMonochrome={appLogoMonochrome} />}
              {phase === "cant-play" && <CantPlayBody name={name} />}
            </div>
          )}
          {!isEmbed && phase === "delayed" && latency !== null && (
            <span className="absolute" style={{ ...CORNER_LABEL, top: 8, background: "rgba(0,0,0,0.6)", color: "#ffca16", fontWeight: 600 }}>
              {latency} s behind
            </span>
          )}
        </>
      )}
      {showTag && (
        <span
          className="absolute"
          style={{ ...CORNER_LABEL, bottom: 8, background: "rgba(0,0,0,0.55)", color: "rgba(255,255,255,0.92)", fontWeight: 500 }}
        >
          {name}
        </span>
      )}
    </div>
  );
}

function StateText({ big, small }: { big: string; small: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center" style={{ gap: 6, padding: 12 }}>
      <span style={{ color: "rgba(255,255,255,0.92)", fontWeight: 600, fontSize: "clamp(12px, 2.2cqw, 18px)" }}>{big}</span>
      <span style={{ color: "rgba(255,255,255,0.45)", fontSize: "clamp(10px, 1.4cqw, 13px)" }}>{small}</span>
    </div>
  );
}

function ConnectingBody({ name }: { name: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ gap: 6 }}>
      {/* The approved design's own pulse (1.2s, 0.25 to 1) — not the app's
          su-history-pulse-dot (1.6s, 1 to 0.4): the two read as noticeably
          different beats, and the design is the spec here. */}
      <span
        className="video-connecting-pulse inline-block rounded-full"
        style={{ width: 10, height: 10, background: "rgba(255,255,255,0.45)" }}
      />
      <span style={{ color: "rgba(255,255,255,0.45)", fontSize: "clamp(10px, 1.4cqw, 13px)" }}>Connecting to {name}</span>
    </div>
  );
}

function OfflineBody({
  mode,
  name,
  appLogo,
  appLogoMonochrome,
}: {
  mode: "message" | "logo" | "nothing";
  name: string;
  appLogo: string | null;
  appLogoMonochrome: boolean;
}) {
  // "logo" with no app logo configured has nothing to draw — falls through
  // to the message state rather than an empty covered box. "nothing" never
  // reaches here at all: the caller skips the covering wrapper entirely for
  // that mode, so the offline state is genuinely transparent over the video.
  if (mode === "logo" && appLogo) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <BrandLogo logo={appLogo} monochrome={appLogoMonochrome} style={{ width: "22%", aspectRatio: "1", color: "white" }} />
      </div>
    );
  }
  return <StateText big={`${name} is offline`} small="It will appear here when the source comes back" />;
}

function CantPlayBody({ name }: { name: string }) {
  return <StateText big="This screen can't play video" small={`${name} plays on the other screens`} />;
}

function PreviewPausedBody({ name, onPlay }: { name: string; onPlay: () => void }) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{
        background: "repeating-linear-gradient(135deg, #161616 0 10px, #1c1c1c 10px 20px)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div className="flex flex-col items-center" style={{ gap: 6, color: "rgba(255,255,255,0.7)" }}>
        <span style={{ fontSize: "clamp(10px, 1.4cqw, 13px)" }}>{name}</span>
        <span style={{ color: "rgba(255,255,255,0.45)", fontSize: "clamp(9px, 1.3cqw, 12px)" }}>Video paused in preview</span>
        <button
          type="button"
          onClick={onPlay}
          style={{
            background: "rgba(255,255,255,0.1)",
            border: "1px solid rgba(255,255,255,0.18)",
            color: "rgba(255,255,255,0.9)",
            borderRadius: 999,
            padding: "4px 10px",
            fontSize: "clamp(9px, 1.3cqw, 12px)",
            fontWeight: 500,
          }}
        >
          Play
        </button>
      </div>
    </div>
  );
}
