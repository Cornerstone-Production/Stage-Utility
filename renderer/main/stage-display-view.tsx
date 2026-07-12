import { useState, useEffect } from "react";
import { QrHint } from "../components/qr-hint";
import { BrandLogo } from "../components/brand-logo";
import { useDashboardState } from "./use-dashboard-state";
import { useSplState, resolveSplValue } from "./use-spl-state";
import { useTranscript } from "./use-transcript";
import { channelColor, channelLabel } from "./channel-color";
import { LiveControls } from "./live-controls";
import { computePcoTimer, fmtDuration } from "./pco-timer";
import { Loader2Icon } from "lucide-react";

interface StageDisplayViewProps {
  displayId: string;
}

// White vs near-black text for a colored chip, by perceived luminance.
function chipText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#11131a" : "#fff";
}

function SectionChip({ section, size = "md" }: { section: ProSection | null; size?: "sm" | "md" }) {
  if (!section) return null;
  const pad = size === "sm" ? "px-2 py-0.5 text-[clamp(0.7rem,1.6vmin,0.95rem)]" : "px-3 py-1 text-[clamp(0.8rem,2vmin,1.2rem)]";
  // Black groups (Intro/Instrumental) read as a neutral outline rather than invisible.
  const isBlack = /^#0{6}$/i.test(section.colorHex);
  return (
    <span
      className={`inline-block rounded-md font-medium shrink-0 ${pad}`}
      style={
        isBlack
          ? { background: "rgba(255,255,255,0.10)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)" }
          : { background: section.colorHex, color: chipText(section.colorHex) }
      }
    >
      {section.name}
    </span>
  );
}

export function StageDisplayView({ displayId }: StageDisplayViewProps) {
  const { state, isLoading, error, pcoLive, propresenter } = useDashboardState();
  const transcript = useTranscript();
  const spl = useSplState();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [skewMs, setSkewMs] = useState(0);
  useEffect(() => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  }, [pcoLive?.serverNow]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-[100dvh] kiosk-surface gap-3">
        <Loader2Icon className="size-8 text-gray-7 animate-spin" />
        <p className="text-headline text-gray-7">Loading…</p>
      </div>
    );
  }
  if (error || !state) {
    return (
      <div className="flex flex-col items-center justify-center h-[100dvh] kiosk-surface gap-3 px-12 text-center">
        <p className="text-title3 text-gray-9 font-semibold">Could not load stage display</p>
        {error && <p className="text-caption1 text-gray-7">{error}</p>}
      </div>
    );
  }

  const display = state.displays?.find((d) => d.id === displayId) ?? null;
  const displayName = display?.name ?? null;

  const clock = new Date(now);
  const hh = clock.getHours();
  const h12 = String(((hh + 11) % 12) + 1).padStart(2, "0");
  const cmm = String(clock.getMinutes()).padStart(2, "0");
  const css = String(clock.getSeconds()).padStart(2, "0");
  const ampm = hh < 12 ? "AM" : "PM";

  const timer = computePcoTimer(pcoLive, now, skewMs);
  const over = !!timer?.over;

  const pro = propresenter;
  const connected = !!pro?.connected;
  const splVal = resolveSplValue(spl);
  const previewSrc =
    connected && pro?.slidePreviewKey
      ? `/api/propresenter/thumbnail?k=${encodeURIComponent(pro.slidePreviewKey)}`
      : null;
  const runningTimers = pro?.timers ?? [];

  return (
    <div className="flex flex-col h-[100dvh] overscroll-none kiosk-surface text-fg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* Brand top bar */}
      <div
        className="relative flex items-center h-10 shrink-0"
        style={
          {
            background: "rgba(0,0,0,0.50)",
            backdropFilter: "blur(20px) saturate(1.6)",
            borderBottom: "1px solid rgba(255,255,255,0.09)",
          } as React.CSSProperties
        }
      >
        <div className="shrink-0 ml-3 flex items-center gap-2.5 relative z-10">
          <a
            href="/"
            className="flex items-center gap-2 text-fg-muted rounded hover:opacity-80 transition-opacity"
            title="Back to home"
            aria-label="Back to home"
          >
            {state.appLogo && (
              <BrandLogo logo={state.appLogo} monochrome={state.appLogoMonochrome} className="size-5 rounded select-none" />
            )}
            <span className="text-caption1 font-title select-none truncate" style={{ letterSpacing: "0.02em" }}>
              {state.appName}
            </span>
          </a>
          {displayName && (
            <>
              <span className="w-px h-4 bg-white/15 shrink-0" aria-hidden="true" />
              <span className="text-caption1 font-medium text-fg-subtle select-none truncate" style={{ letterSpacing: "0.02em" }}>
                {displayName}
              </span>
            </>
          )}
        </div>
        {state.showQr && state.remoteUrl && (
          <a href="/settings" target="_blank" rel="noopener noreferrer" className="shrink-0 ml-auto mr-3 relative z-10 rounded transition-opacity hover:opacity-70" title="Open settings" aria-label="Open settings">
            <QrHint url={state.remoteUrl} compact />
          </a>
        )}
      </div>

      <div className="flex flex-col flex-1 min-h-0 gap-2.5 max-sm:gap-2 p-3 max-sm:p-2">
        {/* Top strip: remaining slides · clock · PCO live · (SPL when present) */}
        <div className={`grid gap-2.5 h-[16%] min-h-0 ${splVal ? "grid-cols-4" : "grid-cols-3"}`}>
          <Cell label="Remaining slides">
            <span className="text-[clamp(1.5rem,7vmin,3.5rem)] font-medium leading-none tabular-nums">
              {pro?.slidesRemaining ?? "—"}
            </span>
          </Cell>
          <Cell label="Clock">
            <span className="text-[clamp(1.4rem,6vmin,3rem)] font-medium leading-none tabular-nums">
              {h12}:{cmm}<span className="text-fg-subtle text-[0.6em]">:{css} {ampm}</span>
            </span>
          </Cell>
          <Cell
            label={
              !timer
                ? "Planning Center Live"
                : timer.mode === "preservice"
                  ? "Service starts in"
                  : timer.countUp
                    ? "PCO Live · elapsed"
                    : over
                      ? "PCO Live · over"
                      : "PCO Live · remaining"
            }
            accent={timer ? (over ? "red" : "green") : "none"}
          >
            {timer ? (
              <div className="flex flex-col items-center gap-1">
                <span className={`text-[clamp(1.4rem,6vmin,3rem)] font-medium leading-none tabular-nums ${over ? "text-red-10" : "text-live-11"}`}>
                  {fmtDuration(timer.seconds)}
                </span>
                {timer.label && (
                  <span className="text-caption2 text-fg-subtle truncate max-w-full">{timer.label}</span>
                )}
              </div>
            ) : (
              <span className="text-fg-faint text-[clamp(0.8rem,2.4vmin,1.1rem)]">No live service</span>
            )}
          </Cell>
          {splVal && (
            <Cell label={`SPL · ${splVal.metricKey}`}>
              <span className="text-[clamp(1.4rem,6vmin,3rem)] font-medium leading-none tabular-nums">
                {Math.round(splVal.value)}<span className="text-fg-subtle text-[0.6em]"> dB</span>
              </span>
            </Cell>
          )}
        </div>

        {/* Current slide: section chip + text + preview. The preview is hidden on
            phones (max-sm) — the slide text is already shown here, so it's just
            clutter on a small screen; it stays on the wall/desktop display. */}
        <div className="flex flex-1 min-h-0 gap-2.5">
          <div className="flex flex-col flex-1 min-w-0 rounded-2xl border border-line bg-surface p-3 gap-2">
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-caption2 uppercase tracking-wider text-fg-subtle" style={{ letterSpacing: "0.1em" }}>Now</span>
              <SectionChip section={pro?.currentSection ?? null} />
              {pro?.currentNotes && <span className="ml-auto text-[clamp(0.8rem,2vmin,1.1rem)] text-amber-9 font-medium tabular-nums">{pro.currentNotes}</span>}
            </div>
            <div className="flex flex-1 items-center min-h-0">
              <span className="text-[clamp(1.3rem,5vmin,3rem)] font-medium leading-tight line-clamp-4">
                {connected ? (pro?.currentSlideText ?? "—") : "ProPresenter offline"}
              </span>
            </div>
          </div>
          {previewSrc && (
            <div className="w-[34%] max-sm:hidden shrink-0 rounded-2xl border border-line overflow-hidden bg-black flex items-center justify-center">
              <img src={previewSrc} alt="" className="w-full h-full object-contain" />
            </div>
          )}
        </div>

        {/* Next slide */}
        <div className="flex items-center gap-3 rounded-2xl border border-amber-a5 bg-amber-a2 p-2.5 px-3 shrink-0 h-[18%] min-h-0">
          <span className="text-caption2 uppercase tracking-wider text-fg-subtle shrink-0" style={{ letterSpacing: "0.1em" }}>Next</span>
          <SectionChip section={pro?.nextSection ?? null} size="sm" />
          <span className="text-[clamp(1rem,3.4vmin,1.9rem)] font-medium text-amber-10 leading-tight truncate">
            {pro?.nextSlideText ?? "—"}
          </span>
          {pro?.nextArrangementSection && (
            <span className="ml-auto flex items-center gap-2 shrink-0">
              <span className="text-caption2 uppercase tracking-wider text-fg-faint" style={{ letterSpacing: "0.1em" }}>Then</span>
              <SectionChip section={pro.nextArrangementSection} size="sm" />
            </span>
          )}
        </div>

        {/* Service items + running timers */}
        <div className="grid grid-cols-2 gap-2.5 h-[15%] min-h-0 shrink-0">
          <Cell label="Current service item" align="start">
            <span className="text-[clamp(1rem,3.2vmin,1.7rem)] font-medium leading-tight truncate w-full">
              {pcoLive?.currentItemTitle ?? pro?.currentServiceItem ?? "—"}
            </span>
          </Cell>
          <Cell label="Next service item" align="start" accent="amber">
            <div className="flex items-center justify-between gap-3 w-full">
              <span className="text-[clamp(1rem,3.2vmin,1.7rem)] font-medium leading-tight truncate text-amber-10">
                {pcoLive?.nextItemTitle ?? pro?.nextServiceItem ?? "—"}
              </span>
              {runningTimers.length > 0 && (
                <span className="flex items-center gap-2 shrink-0">
                  {runningTimers.slice(0, 2).map((t) => (
                    <span key={t.name} className="text-caption1 text-fg-subtle tabular-nums">
                      {t.name}: <span className="text-fg">{t.time}</span>
                    </span>
                  ))}
                </span>
              )}
            </div>
          </Cell>
        </div>

        {transcript.length > 0 && (() => {
          const last = transcript[transcript.length - 1];
          const speaker = channelLabel(last);
          return (
            <div className="shrink-0 rounded-2xl border border-line bg-surface px-3 py-2 flex items-center gap-3 min-h-0">
              <span
                className="text-caption2 font-semibold uppercase tracking-wider shrink-0 max-w-[28%] truncate"
                style={{ letterSpacing: "0.1em", color: speaker ? channelColor(last.channel) : "rgba(255,255,255,0.4)" }}
              >
                {speaker ?? "Transcript"}
              </span>
              <span className={`text-[clamp(0.9rem,2.6vmin,1.5rem)] truncate ${last.isFinal ? "text-fg" : "text-fg-subtle"}`}>
                {last.text}
              </span>
            </div>
          );
        })()}

        <LiveControls />
      </div>
    </div>
  );
}

function Cell({
  label,
  accent = "none",
  align = "center",
  children,
}: {
  label: string;
  accent?: "none" | "green" | "red" | "amber";
  align?: "center" | "start";
  children: React.ReactNode;
}) {
  const border =
    accent === "green" ? "border-live-9/15 bg-live-9/8"
    : accent === "red" ? "border-red-a6 bg-red-a3"
    : accent === "amber" ? "border-amber-a5 bg-amber-a2"
    : "border-line bg-surface";
  const labelColor =
    accent === "green" ? "text-[#5dcaa5]" : accent === "red" ? "text-red-10" : accent === "amber" ? "text-amber-9" : "text-fg-subtle";
  return (
    <div className={`flex flex-col justify-center rounded-2xl border p-3 min-h-0 overflow-hidden ${border} ${align === "center" ? "items-center" : "items-start"}`}>
      <span className={`text-caption2 font-medium uppercase tracking-wider mb-1 ${labelColor}`} style={{ letterSpacing: "0.1em" }}>
        {label}
      </span>
      {children}
    </div>
  );
}
