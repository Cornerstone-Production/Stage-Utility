// renderer/main/video/listen-control.tsx — the Listen button on a feed's picture:
// a speaker, and once it is on a level meter and a volume slider.
//
// It plays nothing itself. The Video widget's session plays the picture and the
// sound from one WHEP session when this control holds the page's sound
// (use-video-session.ts's `listenPath`); this draws the state and does the three
// things a browser only allows from a tap: unmute the element, start it, and make
// the AudioContext the meter reads through.
//
// Only the operator's own views get it (the Video feeds page and a Home card),
// never a wall or a kiosk: video-object.tsx is told whether to offer it.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { errorMessage } from "@main/services/errors";
import { METER_BARS, attachMeter } from "./listen-meter";
import { mute, readVolume, startFromTap, unmute, writeVolume, type ListenTone, type ListenView } from "./listen";

const TONE_COLOR: Record<ListenTone, string> = {
  muted: "#9a9aa2",
  starting: "#6aa6df",
  live: "#86efac",
  warn: "#fbbf24",
  quiet: "#a8a8b0",
};

const BAR_REST_PX = 4;
const BAR_SPAN_PX = 18;

function AudioContextCtor(): typeof AudioContext | null {
  const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export function ListenControl({
  view,
  name,
  videoEl,
  wanted,
  onToggle,
}: {
  view: ListenView;
  name: string;
  videoEl: HTMLVideoElement | null;
  /** This control holds the page's sound. */
  wanted: boolean;
  /** `true` to take the page's sound, `false` to give it up. Called last in the tap. */
  onToggle: (next: boolean) => void;
}) {
  const [volume, setVolume] = useState(() => readVolume());
  // The browser refusing to play with sound is the one failure only a tap's
  // own play() reports; the session cannot see it.
  const [blocked, setBlocked] = useState<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);

  // The element's sound follows the claim: unmuted at the saved level while this
  // control holds it, muted again the moment it does not (another feed took it,
  // the page was left, the feed lost its audio).
  useEffect(() => {
    if (!wanted || !videoEl) return undefined;
    unmute(videoEl, volume);
    return () => mute(videoEl);
  }, [wanted, videoEl, volume]);

  // The AudioContext lives exactly as long as the claim.
  useEffect(() => {
    if (!wanted) return undefined;
    return () => {
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx && ctx.state !== "closed") void ctx.close();
    };
  }, [wanted]);

  const paintBars = useCallback((levels: number[]) => {
    let peak = 0;
    levels.forEach((level, i) => {
      peak = Math.max(peak, level);
      const bar = barRefs.current[i];
      if (!bar) return;
      const h = BAR_REST_PX + Math.min(1, level * 1.6) * BAR_SPAN_PX;
      bar.style.height = `${h.toFixed(0)}px`;
      bar.style.background = h > 18 ? "#fbbf24" : "#86efac";
    });
    if (meterRef.current) meterRef.current.dataset.level = peak.toFixed(3);
  }, []);

  useEffect(() => {
    if (!view.playing || !videoEl) return undefined;
    const ctx = ctxRef.current;
    const stream = videoEl.srcObject;
    if (!ctx || !stream || typeof (stream as MediaStream).getAudioTracks !== "function") return undefined;
    return attachMeter(ctx, stream as MediaStream, paintBars) ?? undefined;
  }, [view.playing, videoEl, paintBars]);

  function tap() {
    if (view.on) {
      onToggle(false);
      return;
    }
    // Everything a browser's autoplay rules want from a gesture happens here,
    // in the tap itself and not in an effect after it: unmute the element and
    // start it, and make the AudioContext. The session then swaps the element's
    // stream, which a gesture-unmuted element may play with sound.
    if (videoEl) {
      setBlocked(null);
      startFromTap(videoEl, volume).catch((err: unknown) => setBlocked(errorMessage(err)));
    }
    const Ctor = AudioContextCtor();
    if (Ctor && !ctxRef.current) {
      try {
        ctxRef.current = new Ctor();
        void ctxRef.current.resume();
      } catch {
        ctxRef.current = null; // no meter; the sound does not need it
      }
    }
    onToggle(true);
  }

  const text = blocked !== null && view.on ? `The browser would not play sound: ${blocked}` : view.text;
  const tone: ListenTone = blocked !== null && view.on ? "warn" : view.tone;
  const control: CSSProperties = {
    width: "clamp(36px, 8cqw, 44px)",
    height: "clamp(36px, 8cqw, 44px)",
    borderRadius: 10,
    border: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: view.disabled ? "transparent" : view.on ? "#2e6691" : "rgba(255,255,255,0.1)",
    color: view.disabled ? "#8a8a92" : view.on ? "#fff" : "#ededf0",
    cursor: view.disabled ? "not-allowed" : "pointer",
  };

  return (
    <div
      data-listen-control=""
      // A press here is the control's, not the card's: it must not start a card's
      // long-press menu or drag.
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute flex flex-col items-end"
      style={{ right: "clamp(6px, 1.6cqw, 12px)", bottom: "clamp(6px, 1.6cqw, 12px)", gap: 6, maxWidth: "calc(100% - 12px)" }}
    >
      {text !== "" && (
        <div
          role="status"
          data-listen-status=""
          style={{
            padding: "3px 8px",
            borderRadius: 8,
            background: "rgba(0,0,0,0.66)",
            color: TONE_COLOR[tone],
            fontSize: "clamp(10px, 1.7cqw, 13px)",
            lineHeight: 1.35,
            textAlign: "right",
          }}
        >
          {text}
        </div>
      )}
      <div className="flex items-center" style={{ gap: 10, padding: 6, borderRadius: 12, background: "rgba(0,0,0,0.66)" }}>
        {view.playing && (
          <div
            ref={meterRef}
            data-listen-meter=""
            data-level="0.000"
            aria-hidden="true"
            className="flex items-end"
            style={{ gap: 3, height: 22, paddingLeft: 6 }}
          >
            {Array.from({ length: METER_BARS }, (_, i) => (
              <span
                key={i}
                ref={(el) => {
                  barRefs.current[i] = el;
                }}
                style={{ width: 4, height: BAR_REST_PX, borderRadius: 2, background: "#86efac" }}
              />
            ))}
          </div>
        )}
        {view.playing && (
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            aria-label={`Volume for ${name}`}
            onChange={(e) => {
              const next = Number(e.target.value) / 100;
              setVolume(next);
              writeVolume(next);
            }}
            style={{ width: "clamp(64px, 14cqw, 110px)", accentColor: "#6aa6df" }}
          />
        )}
        <button
          type="button"
          aria-label={view.on ? `Stop listening to ${name}` : `Listen to ${name}`}
          aria-pressed={view.on}
          disabled={view.disabled}
          title={view.disabled ? view.text : undefined}
          onClick={tap}
          style={control}
        >
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
            {view.on ? (
              <>
                <path d="M15.5 9a4 4 0 0 1 0 6" />
                <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
              </>
            ) : (
              <>
                <path d="M16 9.5l5 5" />
                <path d="M21 9.5l-5 5" />
              </>
            )}
          </svg>
        </button>
      </div>
    </div>
  );
}
