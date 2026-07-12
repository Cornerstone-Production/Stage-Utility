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

interface DashboardViewProps {
  displayId: string;
}

export function DashboardView({ displayId }: DashboardViewProps) {
  const { state, isLoading, error, pcoLive, propresenter } = useDashboardState();
  const transcript = useTranscript();
  const spl = useSplState();

  // One ticking clock drives both the wall clock and the live countdown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Skew between this client and the server, recomputed whenever a pco:live
  // arrives, so the countdown matches the server clock even if this kiosk drifts.
  const [skewMs, setSkewMs] = useState(0);
  useEffect(() => {
    if (pcoLive?.serverNow) {
      setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
    }
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
        <p className="text-title3 text-gray-9 font-semibold">Could not load dashboard</p>
        {error && <p className="text-caption1 text-gray-7">{error}</p>}
      </div>
    );
  }

  const display = state.displays?.find((d) => d.id === displayId) ?? null;
  const displayName = display?.name ?? null;

  // Wall clock.
  const clock = new Date(now);
  const hh = clock.getHours();
  const h12 = String(((hh + 11) % 12) + 1).padStart(2, "0");
  const mm = String(clock.getMinutes()).padStart(2, "0");
  const ss = String(clock.getSeconds()).padStart(2, "0");
  const ampm = hh < 12 ? "AM" : "PM";

  // PCO live timer: counts down on fixed-length items, up otherwise.
  const timer = computePcoTimer(pcoLive, now, skewMs);
  const over = !!timer?.over;

  const pro = propresenter;
  const proConnected = !!pro?.connected;

  return (
    <div className="flex flex-col h-[100dvh] overscroll-none kiosk-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* Brand top bar — same as kiosk, no plan/context label. */}
      <div
        className="relative flex items-center h-10 shrink-0"
        style={
          {
            background: "rgba(0,0,0,0.50)",
            backdropFilter: "blur(20px) saturate(1.6)",
            borderBottom: "1px solid rgba(255,255,255,0.09)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 8px rgba(0,0,0,0.40)",
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
              <BrandLogo
                logo={state.appLogo}
                monochrome={state.appLogoMonochrome}
                className="size-5 rounded select-none"
              />
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
          <a
            href="/settings"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 ml-auto mr-3 relative z-10 rounded transition-opacity hover:opacity-70"
            title="Open settings"
            aria-label="Open settings"
          >
            <QrHint url={state.remoteUrl} compact />
          </a>
        )}
      </div>

      {/* Content: the tiles, transcript strip, and live controls share ONE
          padding + gap so every pill lines up to the same width/inset. */}
      <div className="flex flex-col flex-1 min-h-0 gap-3 max-sm:gap-2 p-4 max-sm:p-2">
      <div className="grid flex-1 min-h-0 grid-cols-2 grid-rows-2 gap-3 max-sm:grid-cols-1 max-sm:grid-rows-4 max-sm:gap-2">
        {/* Clock */}
        <Tile label="Current time">
          <div className="flex items-baseline gap-2 tabular-nums">
            <span className="text-[clamp(2rem,9vmin,5rem)] font-medium text-fg leading-none">
              {h12}:{mm}
            </span>
            <span className="text-[clamp(1rem,4vmin,2rem)] text-fg-subtle leading-none">{ss}</span>
            <span className="text-[clamp(0.8rem,2.5vmin,1.25rem)] text-fg-subtle leading-none">{ampm}</span>
          </div>
        </Tile>

        {/* PCO timer — always counts down (to service start, then per item) */}
        <Tile
          label={
            !timer
              ? "Service timer"
              : timer.mode === "preservice"
                ? "Service starts in"
                : timer.countUp
                  ? "Live · elapsed"
                  : over
                    ? "Live · item over"
                    : "Live · item remaining"
          }
          accent={timer ? (over ? "red" : "green") : "none"}
        >
          {timer ? (
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={`text-[clamp(2rem,9vmin,5rem)] font-medium leading-none tabular-nums ${
                  over ? "text-red-10" : "text-live-11"
                }`}
              >
                {fmtDuration(timer.seconds)}
              </span>
              <span className="text-caption1 text-fg-subtle truncate max-w-full">
                {timer.label ?? (timer.mode === "preservice" ? "Service start" : "Current item")}
              </span>
            </div>
          ) : (
            <span className="text-body text-fg-faint">No live service</span>
          )}
        </Tile>

        {/* ProPresenter — now */}
        <Tile label="ProPresenter · now">
          {proConnected ? (
            <div className="flex flex-col gap-2 w-full px-1">
              <span className="text-[clamp(1.1rem,4vmin,2rem)] font-medium text-fg leading-tight truncate">
                {pro?.currentItem ?? "—"}
              </span>
              {pro?.slideCount != null && pro?.slideIndex != null ? (
                <div className="flex items-center gap-2.5">
                  <span className="text-caption1 text-fg-subtle shrink-0 tabular-nums">
                    Slide {pro.slideIndex} of {pro.slideCount}
                  </span>
                  <span className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
                    <span
                      className="block h-full bg-fg"
                      style={{ width: `${Math.min(100, Math.round((pro.slideIndex / pro.slideCount) * 100))}%` }}
                    />
                  </span>
                  <span className="text-caption1 text-fg-muted shrink-0 tabular-nums">
                    {pro.slidesRemaining ?? 0} left
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <span className="text-body text-fg-faint">ProPresenter offline</span>
          )}
        </Tile>

        {/* ProPresenter — next */}
        <Tile label="Up next">
          {proConnected ? (
            <span className="text-[clamp(1.1rem,4vmin,2rem)] font-medium text-fg-muted leading-tight truncate px-1">
              {pro?.nextItem ?? "—"}
            </span>
          ) : (
            <span className="text-body text-fg-faint">—</span>
          )}
        </Tile>
      </div>

        <SplStrip spl={spl} />

        <TranscriptStrip lines={transcript} />

        <LiveControls />
      </div>
    </div>
  );
}

/** Compact live-transcript strip — only renders when ProdCom has lines. */
function TranscriptStrip({ lines }: { lines: TranscriptLineDTO[] }) {
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  const speaker = channelLabel(last);
  return (
    <div className="shrink-0 rounded-2xl border border-line bg-surface px-4 py-3 flex items-center gap-3 min-h-0">
      <span
        className="text-caption2 font-semibold uppercase tracking-wider shrink-0 max-w-[28%] truncate"
        style={{ letterSpacing: "0.1em", color: speaker ? channelColor(last.channel) : "rgba(255,255,255,0.4)" }}
      >
        {speaker ?? "Transcript"}
      </span>
      <span className={`text-[clamp(0.9rem,2.4vmin,1.4rem)] truncate ${last.isFinal ? "text-fg" : "text-fg-subtle"}`}>
        {last.text}
      </span>
    </div>
  );
}

/** Live SPL readout — only renders when Smaart is connected and reporting. */
function SplStrip({ spl }: { spl: SplMetricsDTO | null }) {
  const r = resolveSplValue(spl);
  if (!r) return null;
  return (
    <div className="shrink-0 rounded-2xl border border-line bg-surface px-4 py-3 flex items-center gap-3 min-h-0">
      <span
        className="text-caption2 font-semibold uppercase tracking-wider shrink-0 text-fg-subtle"
        style={{ letterSpacing: "0.1em" }}
      >
        SPL
      </span>
      <span className="text-[clamp(1.4rem,5vmin,2.4rem)] font-medium text-fg leading-none tabular-nums">
        {Math.round(r.value)}
        <span className="text-[0.5em] text-fg-subtle ml-1">dB</span>
      </span>
      <span className="text-caption1 text-fg-subtle ml-auto truncate">
        {r.metricKey} · {r.meterLabel}
      </span>
    </div>
  );
}

function Tile({
  label,
  accent = "none",
  children,
}: {
  label: string;
  accent?: "none" | "green" | "red";
  children: React.ReactNode;
}) {
  const border =
    accent === "green"
      ? "border-live-9/15 bg-live-9/8"
      : accent === "red"
        ? "border-red-a6 bg-red-a3"
        : "border-line bg-surface";
  const labelColor = accent === "green" ? "text-live-11" : accent === "red" ? "text-red-10" : "text-fg-subtle";
  return (
    <div className={`flex flex-col items-center justify-center rounded-2xl border p-4 max-sm:p-3 min-h-0 ${border}`}>
      <span
        className={`text-caption2 font-medium uppercase tracking-wider mb-2 ${labelColor}`}
        style={{ letterSpacing: "0.1em" }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}
