// renderer/main/video/video-object.tsx — the Video widget: playback choice,
// a receive-only WHEP client for WebRTC, HLS as the fallback, the platform's
// own iframe for an embed feed, and every state a screen can show.
//
// Always muted, no controls: the widget has no audio track and no scrub bar
// to hide (see global-constraints.md).

import { useEffect, useMemo, useRef, useState } from "react";

import { BrandLogo } from "../../components/brand-logo";
import { ErrorBoundary } from "../../components/ui/error-boundary-view";
import { logToServer } from "../../lib/client-log";
import { useLatestRef } from "@renderer/lib/use-latest-ref";
import { browserCaps, choosePlayback } from "./choose-playback";
import { startHls, type HlsSession } from "./hls-player";
import { useOnScreen } from "./use-on-screen";
import { useVideoState } from "./use-video-state";
import { startWhep, type WhepSession } from "./whep-client";

const HIDDEN_TEARDOWN_MS = 3000;
const CONNECT_TIMEOUT_MS = 10_000;
const FIRST_FRAME_TIMEOUT_MS = 5000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** How long a webrtc connectionState of failed/disconnected must persist, once
 *  a session was already showing a picture, before it counts as dropped. */
const DROP_GRACE_MS = 3000;

type VideoObjectConfig = Extract<LayoutObjectConfig, { type: "video" }>;

/** Where playback currently stands, once a feed is chosen and on screen. */
type Phase = "waiting" | "connecting" | "live" | "delayed" | "offline" | "cant-play";

function isPreviewRoute(): boolean {
  return window.location.pathname.startsWith("/preview-");
}

/** A WHEP or an hls.js/native session, tagged so stopping either is one call
 *  without a structural guess at which shape `session` holds. */
type Session = { kind: "webrtc"; s: WhepSession } | { kind: "hls"; s: HlsSession };

function stopSession(session: Session | null): void {
  if (!session) return;
  if (session.kind === "webrtc") void session.s.stop();
  else session.s.stop();
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
    <ErrorBoundary fallback={<CantPlayBody name="This feed" />}>
      {/* Keyed on the feed id: a different feed (or one disappearing) is a clean
          remount, so a verdict about the PREVIOUS feed's WebRTC support, or a
          pending backoff timer, can never carry onto the next one. */}
      <VideoObjectBody
        key={config.feedId ?? "none"}
        objectId={o.id}
        config={config}
        appLogo={appLogo}
        appLogoMonochrome={appLogoMonochrome}
      />
    </ErrorBoundary>
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
  const feedRef = useLatestRef(feed);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScreen = useOnScreen(containerRef, HIDDEN_TEARDOWN_MS);

  const [previewPaused, setPreviewPaused] = useState(isPreviewRoute);
  const [webrtcFailed, setWebrtcFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);

  // Primitives, not `feed` itself: useVideoState hands back a NEW object on
  // every push, including one that changes nothing about non-editing feed. An
  // object-identity dependency would tear the session down and rebuild it on
  // every unrelated feed's update — the flapping this file exists to avoid.
  const playKey = feed ? JSON.stringify(feed.play) : null;
  const statusState = feed?.status.state ?? null;
  const delayedBecause = feed?.status.delayedBecause ?? null;
  const via = feed?.play.via ?? null;

  useEffect(() => {
    if (!onScreen || previewPaused) return undefined;
    const current = feedRef.current;
    if (!current || feedDeleted) {
      setPhase("offline");
      setEmbedUrl(null);
      return undefined;
    }

    // Only a relay feed is one Stage Utility actually monitors — an external or
    // embed source's health is never reported, so those always attempt to play
    // (see VideoSource's `external` comment in main/types/video.ts).
    const monitored = current.play.via === "relay";
    if (monitored && (statusState === "waiting" || statusState === "standby" || statusState === null)) {
      setPhase("waiting");
      setEmbedUrl(null);
      return undefined;
    }
    if (monitored && statusState === "offline") {
      setPhase("offline");
      setEmbedUrl(null);
      return undefined;
    }

    const choice = choosePlayback({
      play: current.play,
      status: current.status,
      caps: browserCaps(),
      allowHls: true, // PR 1: always on; a later PR wires the per-screen switch.
      webrtcFailed,
    });

    if (choice.method === "embed") {
      setEmbedUrl(choice.url);
      setPhase("live");
      return undefined;
    }
    setEmbedUrl(null);

    if (choice.method === "none") {
      setPhase("cant-play");
      return undefined;
    }

    setPhase("connecting");
    let cancelled = false;
    let session: Session | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    let dropTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let latencyInterval: ReturnType<typeof setInterval> | undefined;
    let frameCbHandle: number | undefined;
    let gotFirstFrame = false;

    const clearTimers = () => {
      clearTimeout(connectTimer);
      clearTimeout(frameTimer);
      clearTimeout(dropTimer);
      clearTimeout(retryTimer);
      clearInterval(latencyInterval);
      const v = videoRef.current as (HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }) | null;
      if (frameCbHandle !== undefined && v?.cancelVideoFrameCallback) v.cancelVideoFrameCallback(frameCbHandle);
    };

    // Logged once per transition, not on every render this stays true for —
    // an operator reading /log wants to know WebRTC gave up on this feed and
    // this screen dropped to HLS, not to see the same line on every re-render.
    const failWebrtc = () => {
      setWebrtcFailed((already) => {
        if (!already) logToServer("video", `WebRTC failed for "${current.name}" on this screen; falling back to HLS`);
        return true;
      });
    };

    // Exponential backoff, reset by a fresh mount of this effect (a new feed,
    // status push, or webrtcFailed flip) — see the `attempt` dependency below.
    const scheduleRetry = () => {
      if (cancelled) return;
      setPhase("offline");
      const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt);
      logToServer("video", `"${current.name}" dropped on this screen; retrying in ${delay}ms (attempt ${attempt + 1})`);
      retryTimer = setTimeout(() => {
        if (!cancelled) setAttempt((a) => a + 1);
      }, delay);
    };

    const onFirstFrame = () => {
      if (cancelled || gotFirstFrame) return;
      gotFirstFrame = true;
      clearTimeout(frameTimer);
      if (choice.method === "hls" && session?.kind === "hls") {
        setPhase("delayed");
        const hlsSession = session.s;
        const tick = () => {
          const l = hlsSession.latencySeconds();
          setLatency(l === null ? null : Math.max(1, Math.round(l)));
        };
        tick();
        latencyInterval = setInterval(tick, 1000);
      } else {
        setPhase("live");
      }
    };

    const waitForFirstFrame = () => {
      const v = videoRef.current as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }) | null;
      if (!v) return;
      let poll: ReturnType<typeof setInterval> | undefined;
      if (typeof v.requestVideoFrameCallback === "function") {
        frameCbHandle = v.requestVideoFrameCallback(onFirstFrame);
      } else {
        poll = setInterval(() => {
          if (v.getVideoPlaybackQuality().totalVideoFrames > 0) {
            clearInterval(poll);
            onFirstFrame();
          }
        }, 200);
      }
      frameTimer = setTimeout(() => {
        if (gotFirstFrame) return;
        clearInterval(poll);
        // Never got going: a verdict about THIS attempt, not a mid-stream drop.
        if (choice.method === "webrtc") failWebrtc();
        else scheduleRetry();
        stopSession(session);
      }, FIRST_FRAME_TIMEOUT_MS);
    };

    // A drop AFTER a picture was already showing: retry the SAME method with
    // backoff, rather than downgrading — a brief network hiccup on a screen
    // that WebRTC already proved it can carry is not "WebRTC doesn't work here".
    const onDroppedAfterFrame = () => {
      if (cancelled) return;
      scheduleRetry();
      stopSession(session);
    };

    const onWebrtcConnectionChange = (pc: RTCPeerConnection) => {
      if (cancelled) return;
      const s = pc.connectionState;
      if (s === "connected") {
        clearTimeout(connectTimer);
        clearTimeout(dropTimer);
        if (!gotFirstFrame) waitForFirstFrame();
      } else if (s === "failed" || s === "disconnected") {
        if (gotFirstFrame) {
          dropTimer = setTimeout(onDroppedAfterFrame, DROP_GRACE_MS);
        } else {
          failWebrtc();
          stopSession(session);
        }
      }
    };

    (async () => {
      const video = videoRef.current;
      if (!video) return;
      if (choice.method === "webrtc") {
        let whep: WhepSession;
        try {
          whep = await startWhep(choice.url, video);
        } catch {
          if (!cancelled) failWebrtc();
          return;
        }
        if (cancelled) {
          void whep.stop();
          return;
        }
        session = { kind: "webrtc", s: whep };
        connectTimer = setTimeout(() => {
          if (whep.pc.connectionState !== "connected") {
            failWebrtc();
            stopSession(session);
          }
        }, CONNECT_TIMEOUT_MS);
        whep.pc.addEventListener("connectionstatechange", () => onWebrtcConnectionChange(whep.pc));
        if (whep.pc.connectionState === "connected") onWebrtcConnectionChange(whep.pc);
      } else {
        let hls: HlsSession;
        try {
          hls = await startHls(choice.url, video, { onFatal: () => onDroppedAfterFrame() });
        } catch {
          if (!cancelled) scheduleRetry();
          return;
        }
        if (cancelled) {
          hls.stop();
          return;
        }
        session = { kind: "hls", s: hls };
        waitForFirstFrame();
      }
      video.addEventListener("error", () => {
        if (cancelled) return;
        if (gotFirstFrame) onDroppedAfterFrame();
        else if (choice.method === "webrtc") failWebrtc();
        else scheduleRetry();
      });
    })();

    return () => {
      cancelled = true;
      clearTimers();
      stopSession(session);
    };
    // feedRef/videoRef are refs (stable identity); the effect re-derives
    // everything else from the primitives below on every real change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreen, previewPaused, feedDeleted, config.feedId, playKey, statusState, delayedBecause, via, webrtcFailed, attempt]);

  const name = feed?.name ?? "This feed";
  const isEmbed = embedUrl !== null;
  const showLabel = config.showLabel !== false;
  const showTag = showLabel && !previewPaused && (isEmbed || phase === "live" || phase === "delayed");

  if (!config.feedId) {
    return (
      <div className="flex items-center justify-center w-full h-full" style={{ color: "rgba(255,255,255,0.3)" }}>
        Choose a feed
      </div>
    );
  }

  return (
    <div ref={containerRef} data-video-object={objectId} className="relative w-full h-full bg-black overflow-hidden">
      {previewPaused ? (
        <PreviewPausedBody onPlay={() => setPreviewPaused(false)} />
      ) : (
        <>
          {!isEmbed && (
            <video
              ref={videoRef}
              muted
              playsInline
              autoPlay
              disablePictureInPicture
              className="absolute inset-0 w-full h-full"
              style={{ objectFit: config.fit ?? "contain", opacity: phase === "live" || phase === "delayed" ? 1 : 0 }}
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
          {!isEmbed && phase === "waiting" && (
            <StateText big="Waiting for the source" small="Nothing is sending to this feed yet" />
          )}
          {!isEmbed && phase === "connecting" && <ConnectingBody name={name} />}
          {!isEmbed && phase === "offline" && (
            <OfflineBody mode={config.whenOffline ?? "message"} name={name} appLogo={appLogo} appLogoMonochrome={appLogoMonochrome} />
          )}
          {!isEmbed && phase === "cant-play" && <CantPlayBody name={name} />}
          {!isEmbed && phase === "delayed" && (
            <span
              className="absolute bottom-2 right-2 rounded px-1.5 py-0.5 text-caption2 text-white"
              style={{ background: "rgba(0,0,0,0.6)" }}
            >
              {latency === null ? "delayed" : `${latency} s behind`}
            </span>
          )}
        </>
      )}
      {showTag && (
        <span
          className="absolute top-2 left-2 rounded px-1.5 py-0.5 text-caption2 text-white"
          style={{ background: "rgba(0,0,0,0.55)" }}
        >
          {name}
        </span>
      )}
    </div>
  );
}

function StateText({ big, small }: { big: string; small: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center px-4" style={{ color: "white" }}>
      <span className="text-body font-semibold">{big}</span>
      <span className="text-footnote" style={{ color: "rgba(255,255,255,0.6)" }}>
        {small}
      </span>
    </div>
  );
}

function ConnectingBody({ name }: { name: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" style={{ color: "white" }}>
      <span className="inline-block size-2 rounded-full animate-pulse" style={{ background: "rgba(255,255,255,0.7)" }} />
      <span className="text-footnote" style={{ color: "rgba(255,255,255,0.7)" }}>
        Connecting to {name}
      </span>
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
  if (mode === "nothing") return null;
  if (mode === "logo") {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <BrandLogo logo={appLogo} monochrome={appLogoMonochrome} className="size-10" style={{ color: "white" }} />
      </div>
    );
  }
  return <StateText big={`${name} is offline`} small="It will appear here when the source comes back" />;
}

function CantPlayBody({ name }: { name: string }) {
  return <StateText big="This screen can't play video" small={`${name} plays on the other screens`} />;
}

function PreviewPausedBody({ onPlay }: { onPlay: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" style={{ color: "white" }}>
      <span className="text-footnote" style={{ color: "rgba(255,255,255,0.45)" }}>
        Video paused in preview
      </span>
      <button
        type="button"
        onClick={onPlay}
        className="rounded-md px-3 py-1.5 text-footnote bg-white/10 hover:bg-white/20 text-white transition-colors"
      >
        Play
      </button>
    </div>
  );
}
