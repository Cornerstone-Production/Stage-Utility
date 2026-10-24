// renderer/main/video/listen-control.tsx — the Listen button on a feed's picture.
//
// It plays nothing itself: the Video widget's session plays picture and sound from one
// WHEP session while this control holds the page's sound. This draws the state and does
// what a browser only allows from a tap: unmute and start the element, and make the
// AudioContext the meter reads through. Only the operator's own views get it.

import { useCallback, useEffect, useRef, useState } from "react";

import { Callout } from "../../components/ui/callout";
import { cn } from "../../lib/cn";
import { errorMessage } from "@main/services/errors";
import { METER_BARS, attachMeter, useMeterContext } from "./listen-meter";
import { readVolume, setSound, startFromTap, writeVolume, type ListenView } from "./listen";

const BAR_REST_PX = 4;
const BAR_SPAN_PX = 18;
const BAR_PEAK_PX = 18;
// Dark-ground tokens (.kiosk-surface), so the caption reads over any frame in either theme.
const TONE_TEXT = { plain: "text-fg", starting: "text-accent-text", live: "text-ok-11", warn: "" } as const;
const SIZE = "clamp(36px, 8cqw, 44px)";

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
  /** Takes the page's sound, or gives it up. Called last in the tap. */
  onToggle: () => void;
}) {
  const [volume, setVolume] = useState(() => readVolume());
  // Only the tap's own play() learns the browser refused sound; the session cannot see it.
  const [blocked, setBlocked] = useState<string | null>(null);
  const meterContext = useMeterContext(wanted);
  const meterRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);

  // The element's sound follows the claim: on at the saved level while this control holds it, muted the moment it does not.
  useEffect(() => {
    if (!wanted || !videoEl) return undefined;
    setSound(videoEl, volume);
    return () => setSound(videoEl, null);
  }, [wanted, videoEl, volume]);

  // Bars are written straight to the DOM: a state update every 80 ms would re-render the control over live video.
  const paintBars = useCallback((levels: number[]) => {
    let peak = 0;
    levels.forEach((level, i) => {
      peak = Math.max(peak, level);
      const bar = barRefs.current[i];
      if (!bar) return;
      const h = BAR_REST_PX + Math.min(1, level * 1.6) * BAR_SPAN_PX;
      bar.style.height = `${h.toFixed(0)}px`;
      bar.classList.toggle("bg-warn-9", h > BAR_PEAK_PX);
      bar.classList.toggle("bg-ok-9", h <= BAR_PEAK_PX);
    });
    if (meterRef.current) meterRef.current.dataset.level = peak.toFixed(3);
  }, []);

  useEffect(() => {
    if (!view.playing || !videoEl) return undefined;
    const ctx = meterContext.current();
    const stream = videoEl.srcObject;
    if (!ctx || !stream || typeof (stream as MediaStream).getAudioTracks !== "function") return undefined;
    return attachMeter(ctx, stream as MediaStream, paintBars) ?? undefined;
  }, [view.playing, videoEl, paintBars, meterContext]);

  function tap() {
    if (!view.on) {
      // In the tap itself, not an effect after it: the browser's autoplay rules want the gesture.
      meterContext.open();
      if (videoEl) {
        setBlocked(null);
        startFromTap(videoEl, volume).catch((err: unknown) => {
          // The source swapping under a pending play() is the claim doing its job, not a refusal.
          if ((err as { name?: string } | null)?.name !== "AbortError") setBlocked(errorMessage(err));
        });
      }
    }
    onToggle();
  }

  const refused = blocked !== null && view.on;
  const text = refused ? `The browser would not play sound: ${blocked}` : view.text;
  const tone = refused ? "warn" : view.tone;

  return (
    // kiosk-surface for its dark-ground tokens, over a scrim of our own; a press here is the control's, not the card's.
    <div
      data-listen-control=""
      onPointerDown={(e) => e.stopPropagation()}
      className="kiosk-surface absolute flex flex-col items-end"
      style={{ right: "clamp(6px, 1.6cqw, 12px)", bottom: "clamp(6px, 1.6cqw, 12px)", gap: 6, maxWidth: "calc(100% - 12px)", background: "transparent" }}
    >
      {text !== "" && (
        <div className="rounded-lg bg-black/75">
          <Callout tone={tone === "warn" ? "warn" : "neutral"} role="status" data-listen-status="" className={cn("bg-transparent text-right", TONE_TEXT[tone])}>
            {text}
          </Callout>
        </div>
      )}
      <div className="flex items-center rounded-xl bg-black/65" style={{ gap: 10, padding: 6 }}>
        {view.playing && !meterContext.refused && (
          <div ref={meterRef} data-listen-meter="" data-level="0.000" aria-hidden="true" className="flex items-end" style={{ gap: 3, height: 22, paddingLeft: 6 }}>
            {Array.from({ length: METER_BARS }, (_, i) => (
              <span
                key={i}
                ref={(el) => {
                  barRefs.current[i] = el;
                }}
                className="bg-ok-9"
                style={{ width: 4, height: BAR_REST_PX, borderRadius: 2 }}
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
            style={{ width: "clamp(64px, 14cqw, 110px)", accentColor: "var(--color-accent)" }}
          />
        )}
        <button
          type="button"
          aria-label={view.on ? `Stop listening to ${name}` : `Listen to ${name}`}
          aria-pressed={view.on}
          disabled={view.disabled}
          title={view.disabled ? view.text : undefined}
          onClick={tap}
          className={`flex items-center justify-center rounded-[10px] ${
            view.disabled ? "cursor-not-allowed bg-transparent text-fg-faint" : view.on ? "bg-accent text-white" : "bg-white/10 text-fg"
          }`}
          style={{ width: SIZE, height: SIZE, border: 0 }}
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
