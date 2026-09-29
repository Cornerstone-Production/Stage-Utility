// renderer/main/video/use-video-session.ts — the playback session state
// machine: connect, wait for a frame, badge a delayed picture, detect a drop
// and retry it with backoff. Pulled out of the widget so it is testable with
// fake timers and a fake RTCPeerConnection, with no DOM measurement, no CSS,
// and no React render involved — video-object.tsx keeps only presentation.
//
// Two layers:
//  - `startPlaybackAttempt` is a PLAIN FUNCTION: one attempt at playing one
//    `choice` into one <video> element. It owns every timer and listener for
//    that attempt and reports exactly one terminal outcome — never a retry
//    decision, never React state.
//  - `useVideoSession` is the hook: it decides WHEN to start an attempt (feed
//    known, on screen, not paused), holds the WebRTC-viability verdict and the
//    backoff counter across attempts, and turns each attempt's outcome into
//    render state.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLatestRef } from "@renderer/lib/use-latest-ref";
import type { VideoFeedView } from "@main/types/video";
import { errorMessage } from "@main/services/errors";
import { OutageLog } from "@main/services/repeat-log";
import { browserCaps, choosePlayback } from "./choose-playback";
import { startHls, type HlsSession } from "./hls-player";
import { startWhep, WhepError, type WhepSession } from "./whep-client";

/**
 * A relay feed's WHEP answer in this set means the encoder cannot be
 * carried over WebRTC AT ALL (an unsupported codec/profile, a malformed
 * offer this relay's build rejects) — a verdict about the STREAM, not the
 * network, so it falls back to HLS. Everything else (404 while a push feed's
 * source has not connected yet, a 5xx, a network error) retries the same
 * method: those say nothing about whether WebRTC itself can carry this feed.
 * An EXTERNAL WHEP feed gets none of this — "Stage Utility cannot report its
 * health" (main/types/video.ts), so every failure there retries.
 */
const RELAY_WEBRTC_REFUSAL_STATUSES = new Set([400, 406, 415, 422]);

export const CONNECT_TIMEOUT_MS = 10_000;
export const FIRST_FRAME_TIMEOUT_MS = 5000;
/** HLS gets longer: a segmented playlist's first fetch-and-buffer routinely
 *  takes longer than a WebRTC track's first frame, and unlike WebRTC there is
 *  no faster fallback waiting behind it — a short timeout here would just
 *  retry HLS against itself sooner than the format needs. */
export const HLS_FIRST_FRAME_TIMEOUT_MS = 15_000;
export const RETRY_MIN_MS = 1000;
export const RETRY_MAX_MS = 30_000;
/** How long playback must hold, with no drop, before the backoff starts over
 *  and a failing streak counts as recovered. One frame is not recovery:
 *  Chrome's native HLS player showed one frame of the relay's low-latency
 *  HLS and then failed, every time. */
export const RESET_AFTER_PLAYING_MS = 10_000;
/** A failing streak's "still failing" reminder, at most this often. */
export const STREAK_REMIND_MS = 5 * 60 * 1000;
/** How long a relay feed plays over HLS after WebRTC proved unusable on this
 *  screen before WebRTC is tried again: the verdict is about a moment (a
 *  blocked port, an encoder's settings), not about the screen for ever. */
export const WEBRTC_RETRY_AFTER_MS = 5 * 60 * 1000;
/** How long a webrtc connectionState of failed/disconnected must persist, once
 *  a session was already showing a picture, before it counts as dropped. */
export const DROP_GRACE_MS = 3000;

export type SessionPhase = "connecting" | "waiting" | "live" | "delayed" | "offline" | "cant-play";

interface AttemptCallbacks {
  onPhase: (phase: "connecting" | "live" | "delayed") => void;
  onLatency: (seconds: number | null) => void;
  /**
   * WebRTC cannot be carried on THIS screen for THIS relay feed: it
   * connected but no frame ever arrived, or a working handshake never
   * reached "connected" — a verdict about the browser/network path, not
   * about whether the far end is reachable at all. The caller plays HLS
   * instead, for WEBRTC_RETRY_AFTER_MS. Only ever reported for a relay feed:
   * anything else has no HLS to fall back to, so the same evidence arrives
   * as `onDropped` and is retried with backoff.
   */
  onWebrtcUnusable: (reason: string) => void;
  /**
   * The attempt died for a reason that says nothing about whether THIS
   * METHOD can work here: a POST that never got a reply, a mid-stream
   * disconnect, an hls.js fatal error, the <video> element's own error. The
   * caller should retry the SAME method after a backoff — this is also what
   * an external WHEP feed with no HLS to fall back to needs, since marking
   * it permanently unusable would leave it on "can't play" forever with no
   * path back.
   */
  onDropped: (reason: string) => void;
}

export interface PlaybackAttempt {
  stop: () => void;
}

type ActiveSession = { kind: "webrtc"; s: WhepSession } | { kind: "hls"; s: HlsSession };

function stopActiveSession(session: ActiveSession | null): void {
  if (!session) return;
  if (session.kind === "webrtc") void session.s.stop();
  else session.s.stop();
}

export type PlaybackAttemptChoice =
  | { method: "webrtc"; url: string; relayManaged: boolean }
  | { method: "hls"; url: string };

/**
 * One attempt at playing `choice` into `video`. Every exit path — a frame
 * timeout, a connect timeout, a mid-stream drop, an hls.js fatal error, the
 * `<video>` element's own `error` event, or the caller's own `stop()` —
 * funnels through the single `end()` below, guarded by `ended`, so a timer
 * firing after another one already decided the outcome can never re-stop an
 * already-stopped session (no double DELETE) and can never report a second,
 * contradictory outcome.
 */
export function startPlaybackAttempt(video: HTMLVideoElement, choice: PlaybackAttemptChoice, cb: AttemptCallbacks): PlaybackAttempt {
  const controller = new AbortController();
  let ended = false;
  let gotFirstFrame = false;
  let hasConnected = false; // distinguishes "never got going" from "connected, but stalled before a frame" below
  let session: ActiveSession | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let dropTimer: ReturnType<typeof setTimeout> | undefined;
  let latencyInterval: ReturnType<typeof setInterval> | undefined;
  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let frameCbHandle: number | undefined;

  const clearTimers = () => {
    clearTimeout(connectTimer);
    clearTimeout(frameTimer);
    clearTimeout(dropTimer);
    clearInterval(latencyInterval);
    clearInterval(pollInterval);
    const v = video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
    if (frameCbHandle !== undefined && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(frameCbHandle);
  };

  /** The one way out. `after` fires the caller's callback — but only the
   *  FIRST time anything calls `end`; every later call (a second timer
   *  racing the first, or the caller's own `stop()` after a terminal
   *  outcome already landed) is a silent no-op. */
  const end = (after?: () => void) => {
    if (ended) return;
    ended = true;
    clearTimers();
    controller.abort(); // detaches every listener registered with { signal }
    const s = session;
    session = null;
    stopActiveSession(s);
    // A non-null srcObject takes precedence over `src` on a <video>
    // element, so leaving a WebRTC attempt's MediaStream attached after it
    // ends would play that dead stream's last frame forever instead of the
    // HLS fallback about to attach via `src`.
    if (choice.method === "webrtc") video.srcObject = null;
    after?.();
  };

  /** A "WebRTC can't carry it here" verdict. A relay feed falls back to HLS
   *  on it; any other feed has nothing to fall back to, so for it the same
   *  evidence is a failure like any other and is retried with backoff —
   *  marking an external feed unusable left it on "can't play" until reload,
   *  even once its endpoint was healthy again. */
  const webrtcUnusable = (reason: string) =>
    end(() => (choice.method === "webrtc" && choice.relayManaged ? cb.onWebrtcUnusable(reason) : cb.onDropped(reason)));

  /**
   * Arms the first-frame watch. Called the moment a source is attached — the
   * WHEP answer applied, the HLS source loaded — and never from a connection
   * state event: a picture that is decoding lifts the cover whatever state
   * events were or were not observed. Idempotent.
   */
  let watching = false;
  const watchForFirstFrame = () => {
    if (watching) return;
    watching = true;
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    const markFrame = () => {
      if (ended || gotFirstFrame) return;
      gotFirstFrame = true;
      clearTimeout(connectTimer);
      clearTimeout(frameTimer);
      clearInterval(pollInterval);
      if (choice.method === "hls" && session?.kind === "hls") {
        cb.onPhase("delayed");
        const hlsSession = session.s;
        const tick = () => {
          const l = hlsSession.latencySeconds();
          cb.onLatency(l === null ? null : Math.max(1, Math.round(l)));
        };
        tick();
        latencyInterval = setInterval(tick, 1000);
      } else {
        cb.onPhase("live");
      }
    };
    if (typeof v.requestVideoFrameCallback === "function") {
      frameCbHandle = v.requestVideoFrameCallback(markFrame);
    } else {
      pollInterval = setInterval(() => {
        if (v.getVideoPlaybackQuality().totalVideoFrames > 0) markFrame();
      }, 200);
    }
  };

  /** The failure half: no frame within `timeoutMs` ends the attempt. */
  const firstFrameDeadline = (timeoutMs: number) => {
    clearTimeout(frameTimer);
    frameTimer = setTimeout(() => {
      if (gotFirstFrame) return;
      if (choice.method === "webrtc") webrtcUnusable("connected, but no frame ever arrived");
      else end(() => cb.onDropped("no frame arrived over HLS"));
    }, timeoutMs);
  };

  const onDroppedAfterFrame = (reason: string) => end(() => cb.onDropped(reason));

  if (choice.method === "webrtc") {
    cb.onPhase("connecting");
    // Covers the WHOLE handshake (offer, POST, answer) — a POST that never
    // gets a reply must not hang "Connecting..." forever. Firing here is a
    // NETWORK failure, not a verdict on whether this browser can carry
    // WebRTC, so it retries rather than falling back permanently.
    connectTimer = setTimeout(() => {
      end(() => cb.onDropped("no response to the connection offer"));
    }, CONNECT_TIMEOUT_MS);
    startWhep(choice.url, video, { signal: controller.signal })
      .then((whep) => {
        if (ended) {
          void whep.stop();
          return;
        }
        session = { kind: "webrtc", s: whep };
        clearTimeout(connectTimer);
        watchForFirstFrame();
        // A second, independent window: the handshake succeeded, so THIS
        // timer firing with no frame means WebRTC never delivered a picture on
        // this screen — that IS a verdict about WebRTC here. It fails the
        // attempt whatever connectionState reads: a state that says
        // "connected" with no frame is no less stuck than one that never did.
        connectTimer = setTimeout(() => {
          if (gotFirstFrame) return;
          const why = whep.pc.connectionState === "connected" ? "connected, but no frame ever arrived" : "never connected after a successful handshake";
          webrtcUnusable(why);
        }, CONNECT_TIMEOUT_MS);
        whep.pc.addEventListener(
          "connectionstatechange",
          () => {
            if (ended) return;
            const s = whep.pc.connectionState;
            if (s === "connected") {
              hasConnected = true;
              clearTimeout(dropTimer);
              if (!gotFirstFrame) {
                clearTimeout(connectTimer);
                firstFrameDeadline(FIRST_FRAME_TIMEOUT_MS);
              }
            } else if (s === "failed" || s === "disconnected") {
              if (gotFirstFrame) {
                // Never stack two: disconnected -> failed (or the reverse)
                // must replace the pending drop timer, not orphan it — an
                // orphaned one still fires later even after a RECOVERY back
                // to "connected" clears whichever timer the variable
                // currently holds, calling onDropped on a session that is
                // actually fine.
                clearTimeout(dropTimer);
                dropTimer = setTimeout(() => onDroppedAfterFrame(`connection ${s}`), DROP_GRACE_MS);
              } else if (hasConnected) {
                // Reached "connected" at least once, but a frame never
                // arrived before it dropped again (the same shape as the
                // B-frames case firstFrameDeadline's own timeout reports) —
                // worded differently from the branch below, which never
                // connected at all.
                webrtcUnusable(`connection ${s} before a frame ever arrived`);
              } else {
                webrtcUnusable(`connection ${s} before it ever connected`);
              }
            }
          },
          { signal: controller.signal },
        );
        if (whep.pc.connectionState === "connected") {
          hasConnected = true;
          clearTimeout(connectTimer);
          firstFrameDeadline(FIRST_FRAME_TIMEOUT_MS);
        }
        video.addEventListener(
          "error",
          () => {
            if (ended) return;
            if (gotFirstFrame) onDroppedAfterFrame("the <video> element reported an error");
            else webrtcUnusable("the <video> element reported an error before a frame arrived");
          },
          { signal: controller.signal },
        );
      })
      .catch((err: unknown) => {
        if (ended) return;
        // A relay feed's WHEP answer refusing the offer outright
        // (400/406/415/422) is a verdict about the STREAM — this encoder
        // cannot be carried over WebRTC at all — so it falls back to HLS
        // like any other webrtc-unusable verdict. An external feed's
        // endpoint reports its own health however it likes ("Stage Utility
        // cannot report its health", main/types/video.ts) and gets no HLS to
        // fall back to regardless, so every failure there retries instead.
        if (choice.relayManaged && err instanceof WhepError && RELAY_WEBRTC_REFUSAL_STATUSES.has(err.status)) {
          webrtcUnusable(`the relay refused this feed over WebRTC (${err.message})`);
          return;
        }
        end(() => cb.onDropped(errorMessage(err)));
      });
  } else {
    cb.onPhase("connecting");
    video.srcObject = null; // a non-null srcObject takes precedence over `src` in the element
    startHls(choice.url, video, {
      onFatal: (why) => {
        if (!ended) onDroppedAfterFrame(`hls.js: ${why}`);
      },
    })
      .then((hls) => {
        if (ended) {
          hls.stop();
          return;
        }
        session = { kind: "hls", s: hls };
        watchForFirstFrame();
        firstFrameDeadline(HLS_FIRST_FRAME_TIMEOUT_MS);
        video.addEventListener(
          "error",
          () => {
            if (ended) return;
            onDroppedAfterFrame("the <video> element reported an error");
          },
          { signal: controller.signal },
        );
      })
      .catch((err: unknown) => {
        if (ended) return;
        end(() => cb.onDropped(errorMessage(err)));
      });
  }

  return { stop: () => end() };
}

// ---------------------------------------------------------------- the hook
//
// `computeVerdict` decides what to show WITHOUT ever touching a timer, a
// listener or the network — feed missing/deleted, a relay's confirmed
// waiting/offline status, an embed URL, or "no player here" are all pure
// functions of the feed and this screen's capabilities, so they are computed
// during render (via useMemo below), never through an effect whose entire
// body is a bare setState call. Only the "attempt" verdict needs a REAL side
// effect — an actual WebRTC/HLS session with real timers — which is the one
// case the effect below still owns.

export type Verdict =
  | { kind: "deleted" }
  | { kind: "no-feed" } // active but the feed list, or this feed's relay status, hasn't loaded yet
  | { kind: "waiting" }
  | { kind: "known-offline" }
  | { kind: "embed"; url: string }
  | { kind: "cant-play" }
  | { kind: "attempt"; choice: PlaybackAttemptChoice };

function computeVerdict(
  feedDeleted: boolean,
  feed: VideoFeedView | null,
  allowHls: boolean,
  webrtcFailed: boolean,
  relayRunning: boolean,
): Verdict {
  if (feedDeleted) return { kind: "deleted" };
  if (!feed) return { kind: "no-feed" };

  // Only a relay feed is one Stage Utility actually monitors — an external or
  // embed source's health is never reported, so those always attempt to play
  // (see VideoSource's `external` comment in main/types/video.ts).
  const isRelay = feed.play.via === "relay";
  if (isRelay) {
    const s = feed.status.state;
    // A push feed's "waiting": nothing has sent to it yet, so there is
    // nothing to connect to.
    if (s === "waiting") return { kind: "waiting" };
    // "standby" is a pull feed nothing is watching, or any relay feed while
    // the relay is not running. A pull feed's source is dialled on demand —
    // only once a reader connects — so connecting is what starts it; waiting
    // for it to go live first would wait for ever. With the relay not
    // running nothing answers, so that still waits.
    if (s === "standby" && !(feed.kind === "pull" && relayRunning)) return { kind: "waiting" };
    if (s === "offline") return { kind: "known-offline" }; // confirmed: it WAS live and is down now
    if (s === null) return { kind: "no-feed" }; // no status pushed yet — stay neutral, not a verdict either way
  }

  const choice = choosePlayback({ play: feed.play, status: feed.status, caps: browserCaps(), allowHls, webrtcFailed });
  if (choice.method === "embed") return { kind: "embed", url: choice.url };
  if (choice.method === "none") return { kind: "cant-play" };
  if (choice.method === "webrtc") return { kind: "attempt", choice: { method: "webrtc", url: choice.url, relayManaged: isRelay } };
  return { kind: "attempt", choice };
}

export interface VideoSessionInput {
  /** True only while this widget is on screen, visible, and not preview-paused. */
  active: boolean;
  feed: VideoFeedView | null;
  /** A configured feedId that named nothing in a LOADED feed list. */
  feedDeleted: boolean;
  /**
   * The mounted `<video>` element, or null while none is (an embed feed
   * renders an iframe instead). A STATE VALUE, not a ref: the widget always
   * renders exactly one `<video>`, but a feed's source kind can change from
   * embed to external mid-life without this hook's other inputs changing at
   * all, and a ref's mutation is invisible to an effect's dependency array —
   * reading `videoRef.current` inside the effect left that switch stuck on
   * "no video mounted yet" for ever, with no timer running to ever notice.
   */
  video: HTMLVideoElement | null;
  /** The screen's "Use HLS on this screen" switch; true where it is not set. */
  allowHls: boolean;
  /** Whether the relay is running (video:state's `relay`). A standby pull
   *  feed is connected to only while it is: the playback proxy answers 503
   *  otherwise. */
  relayRunning: boolean;
  /** A line for the widget to put on the `[video]` log: every WebRTC
   *  fallback, and a failing streak's first failure, its reminders (at most
   *  every STREAK_REMIND_MS) and its recovery. Never once per retry. */
  onLog?: (reason: string) => void;
}

export interface VideoSessionResult {
  phase: SessionPhase;
  embedUrl: string | null;
  /** Seconds behind live, while `phase === "delayed"`; null otherwise or
   *  until hls.js/native HLS has reported one. */
  latency: number | null;
}

export function useVideoSession(input: VideoSessionInput): VideoSessionResult {
  const { active, feed, feedDeleted, video, allowHls, relayRunning } = input;
  const feedRef = useLatestRef(feed);
  const onLogRef = useLatestRef(input.onLog);

  const [webrtcFailed, setWebrtcFailed] = useState(false);
  // The verdict expires: after WEBRTC_RETRY_AFTER_MS on HLS, WebRTC is tried
  // again. Clearing it changes the verdict, so the attempt effect below stops
  // the HLS session and starts a WebRTC one; a second refusal sets it again.
  useEffect(() => {
    if (!webrtcFailed) return undefined;
    const t = setTimeout(() => setWebrtcFailed(false), WEBRTC_RETRY_AFTER_MS);
    return () => clearTimeout(t);
  }, [webrtcFailed]);
  const [attemptPhase, setAttemptPhase] = useState<"connecting" | "live" | "delayed" | "offline">("connecting");
  const [latency, setLatency] = useState<number | null>(null);
  // Purely a "try again" SIGNAL for the effect below — bumped only when a
  // backoff timer decides a retry is actually due, so the effect re-runs
  // exactly when a new attempt should start.
  const [retryToken, setRetryToken] = useState(0);
  // The backoff EXPONENT, across every drop in a row — a REF, not state: it
  // must persist between retries (2s, then 4s, then 8s...), but resetting it
  // to 0 on success must never itself retrigger the effect and tear down the
  // session that just succeeded, which is exactly what putting it in state
  // alongside `retryToken` would do. Reset only once playback has held for
  // RESET_AFTER_PLAYING_MS, never on a first frame.
  const attemptCountRef = useRef(0);
  // The failing streak, for the log: its first failure, a reminder at most
  // every STREAK_REMIND_MS, and its recovery — never a line per retry, which
  // from one widget had /api/log/client answering 429 within seconds. The
  // server's own once-per-outage rule (main/services/repeat-log.ts), with no
  // settle window of its own: `ok` is only called once playback has held,
  // which is this hook's settle window.
  const streakRef = useRef<OutageLog | null>(null);
  const streak = () => (streakRef.current ??= new OutageLog(0, STREAK_REMIND_MS));

  // Primitives, not `feed` itself: useVideoState hands back a NEW object on
  // every push, including one that changes nothing about THIS feed. An
  // object-identity dependency would tear a live session down and rebuild it
  // on every unrelated feed's update — the flapping this file exists to
  // avoid.
  const playKey = feed ? JSON.stringify(feed.play) : null;
  const statusState = feed?.status.state ?? null;
  const delayedBecause = feed?.status.delayedBecause ?? null;
  const feedKind = feed?.kind ?? null;

  // `feed` itself is read inside for its `play`/`status`; the primitives
  // listed are the ones that decide whether the verdict can differ.
  const verdict = useMemo(
    () => computeVerdict(feedDeleted, feed, allowHls, webrtcFailed, relayRunning),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feedDeleted, playKey, statusState, delayedBecause, feedKind, allowHls, webrtcFailed, relayRunning],
  );
  // The attempt effect is keyed on WHAT it plays — method, URL, and whether
  // the relay manages it — never on the status that led there: a pull feed's
  // own request is what takes it from standby to live, and restarting the
  // session that did it would drop the picture it just brought up. A status
  // that stops playing (offline, waiting) leaves "attempt" altogether, and
  // one that changes the method (B-frames: WebRTC to HLS) changes this key.
  const attemptKey = verdict.kind === "attempt" ? JSON.stringify(verdict.choice) : null;
  const attemptChoice = useMemo<PlaybackAttemptChoice | null>(
    () => (attemptKey === null ? null : (JSON.parse(attemptKey) as PlaybackAttemptChoice)),
    [attemptKey],
  );

  const embedUrl = active && verdict.kind === "embed" ? verdict.url : null;

  const phase: SessionPhase =
    verdict.kind === "deleted" || verdict.kind === "known-offline"
      ? "offline"
      : verdict.kind === "waiting"
        ? "waiting"
        : verdict.kind === "cant-play"
          ? "cant-play"
          : verdict.kind === "embed"
            ? "live"
            : verdict.kind === "no-feed"
              ? "connecting"
              : attemptPhase;

  useEffect(() => {
    if (!active || !video || !attemptChoice) return undefined;
    const choice = attemptChoice;
    const current = feedRef.current;

    // Legitimately part of the same side effect as the lines below, not a
    // "this could have been a derived render value" case the rule exists to
    // catch: a NEW attempt is genuinely starting (WHEP/HLS, real timers,
    // real listeners), and its visible state must reset to match.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAttemptPhase("connecting");
    setLatency(null);
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let heldTimer: ReturnType<typeof setTimeout> | undefined;
    const name = current?.name ?? "this feed";
    const key = current?.id ?? "";

    const attemptHandle = startPlaybackAttempt(video, choice, {
      onPhase: (p) => {
        setAttemptPhase(p);
        if ((p === "live" || p === "delayed") && heldTimer === undefined) {
          heldTimer = setTimeout(() => {
            attemptCountRef.current = 0;
            const d = streak().ok(key, Date.now());
            if (d.log) onLogRef.current?.(`"${name}" is playing again on this screen${d.note}`);
          }, RESET_AFTER_PLAYING_MS);
        }
      },
      onLatency: setLatency,
      onWebrtcUnusable: (reason) => {
        onLogRef.current?.(`WebRTC unusable for "${name}" on this screen: ${reason}`);
        setWebrtcFailed(true);
      },
      onDropped: (reason) => {
        clearTimeout(heldTimer);
        setAttemptPhase("offline");
        const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attemptCountRef.current);
        attemptCountRef.current += 1;
        const d = streak().fail(key, "dropped", Date.now());
        if (d.log) onLogRef.current?.(`"${name}" failed on this screen (${reason}); retrying with backoff${d.note}`);
        // The browser console only, never the server log: devtools shows
        // Verbose on request, and a retry is not news on /log.
        console.debug(`[video] "${name}" retrying in ${delay} ms (${reason})`);
        retryTimer = setTimeout(() => setRetryToken((t) => t + 1), delay);
      },
    });

    return () => {
      clearTimeout(retryTimer);
      clearTimeout(heldTimer);
      attemptHandle.stop();
    };
  }, [active, video, retryToken, attemptChoice, feedRef, onLogRef]);

  return { phase, embedUrl, latency };
}
