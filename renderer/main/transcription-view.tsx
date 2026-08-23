import { QrHint } from "../components/qr-hint";
import { Tooltip } from "../components/ui/tooltip";
import { BrandLogo } from "../components/brand-logo";
import { useStageState } from "./use-stage-state";
import { useTranscript } from "./use-transcript";
import { TranscriptFeed } from "./transcript-feed";
import { Loader2Icon } from "lucide-react";

interface TranscriptionViewProps {
  displayId: string;
}

export function TranscriptionView({ displayId }: TranscriptionViewProps) {
  const { state, isLoading } = useStageState();
  const lines = useTranscript();

  if (isLoading || !state) {
    return (
      <div className="flex flex-col items-center justify-center h-[var(--screen-h,100dvh)] kiosk-surface gap-3">
        <Loader2Icon className="size-8 text-fg-subtle animate-spin" />
        <p className="text-headline text-fg-subtle">Loading…</p>
      </div>
    );
  }

  const display = state.outputs?.find((o) => o.id === displayId) ?? null;
  const displayName = display?.name ?? null;

  return (
    <div className="flex flex-col h-[var(--screen-h,100dvh)] overscroll-none kiosk-surface text-fg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* Brand top bar */}
      <div
        className="relative flex items-center h-10 shrink-0"
        style={
          {
            background: "rgba(0,0,0,0.50)",
            backdropFilter: "blur(20px)",
            borderBottom: "1px solid rgba(255,255,255,0.09)",
          } as React.CSSProperties
        }
      >
        <div className="shrink-0 ml-3 flex items-center gap-2.5 relative z-10">
          <Tooltip label="Back to home">
            <a
              href="/"
              className="flex items-center gap-2 text-fg-muted rounded hover:opacity-80 transition-opacity"
              aria-label="Back to home"
            >
              {state.appLogo && (
                <BrandLogo logo={state.appLogo} monochrome={state.appLogoMonochrome} className="size-5 rounded select-none" />
              )}
              <span className="text-caption1 font-title select-none truncate" style={{ letterSpacing: "0.02em" }}>
                {state.appName}
              </span>
            </a>
          </Tooltip>
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
          <Tooltip label="Open settings in a new tab">
            <a href="/settings" target="_blank" rel="noopener noreferrer" className="shrink-0 ml-auto mr-3 relative z-10 rounded transition-opacity hover:opacity-70" aria-label="Open settings in a new tab">
              <QrHint url={state.remoteUrl} compact />
            </a>
          </Tooltip>
        )}
      </div>

      {/* Captions — newest at bottom; auto-scrolls only when already at bottom */}
      <TranscriptFeed
        lines={lines}
        scrollable
        colorOverrides={state.captionChannelColors}
        lineClassName="text-[clamp(1.5rem,4.5vmin,3.25rem)]"
        emptyText="Waiting for transcript…"
        className="flex-1 px-[6vw] max-sm:px-4 py-6 max-sm:py-3"
      />
    </div>
  );
}
