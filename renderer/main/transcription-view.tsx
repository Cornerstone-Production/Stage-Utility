import { useEffect, useRef } from "react";
import { QrHint } from "../components/qr-hint";
import { BrandLogo } from "../components/brand-logo";
import { useStageState } from "./use-stage-state";
import { useTranscript } from "./use-transcript";
import { channelColor } from "./channel-color";
import { Loader2Icon } from "lucide-react";

interface TranscriptionViewProps {
  displayId: string;
}

export function TranscriptionView({ displayId }: TranscriptionViewProps) {
  const { state, isLoading } = useStageState();
  const lines = useTranscript();

  // Follow newest line ONLY while the viewer is already at the bottom; if they
  // scroll up to read history, leave them there until they return to the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }
  useEffect(() => {
    if (atBottomRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  if (isLoading || !state) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#080810] gap-3">
        <Loader2Icon className="size-8 text-gray-7 animate-spin" />
        <p className="text-headline text-gray-7">Loading…</p>
      </div>
    );
  }

  const display = state.displays?.find((d) => d.id === displayId) ?? null;
  const displayName = display?.name ?? null;
  const showChannelLabels = lines.some((l) => l.channelName || l.channel);

  return (
    <div className="flex flex-col h-screen bg-[#080810] text-white">
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
            className="flex items-center gap-2 text-white/70 rounded hover:opacity-80 transition-opacity"
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
              <span className="text-caption1 font-medium text-white/40 select-none truncate" style={{ letterSpacing: "0.02em" }}>
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

      {/* Captions — newest at bottom; auto-scrolls only when already at bottom */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto px-[6vw] py-6 flex flex-col justify-end gap-3"
      >
        {lines.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-title3 text-white/30">Waiting for transcript…</span>
          </div>
        ) : (
          lines.map((l) => (
            <p
              key={l.id}
              className="text-[clamp(1.5rem,4.5vmin,3.25rem)] leading-snug"
              style={{ color: channelColor(l.channel), opacity: l.isFinal ? 1 : 0.55 }}
            >
              {showChannelLabels && (l.channelName || l.channel) && (
                <span className="text-[0.5em] font-medium uppercase tracking-wider text-white/40 mr-3 align-middle">
                  {l.channelName ?? l.channel}
                </span>
              )}
              {l.text}
            </p>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
