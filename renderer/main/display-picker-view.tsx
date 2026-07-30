import { QrHint } from "../components/qr-hint";
import { Tooltip } from "../components/ui/tooltip";
import { BrandLogo } from "../components/brand-logo";
import { useStageState } from "./use-stage-state";
import { Loader2Icon, MonitorIcon, ChevronRightIcon, DropletIcon, ListChecksIcon, CableIcon, ClockIcon } from "lucide-react";

// Landing page at "/". Lists the configured displays so a freshly-pointed
// monitor can pick which display it should show. Styled to match the kiosk
// (same dark theme, brand top bar, QR, and empty-slot image) but without any
// plan/context info. Settings is intentionally not listed — it's reachable only
// by clicking the QR (which links to /settings, same as the kiosk).
export function DisplayPickerView() {
  const { state, isLoading, error } = useStageState();

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
        <MonitorIcon className="size-10 text-gray-7" />
        <p className="text-title3 text-gray-9 font-semibold">Could not load displays</p>
        {error && <p className="text-caption1 text-gray-7">{error}</p>}
      </div>
    );
  }

  const centerLogo = state.emptySlotLogo ?? state.appLogo;
  const displays = state.displays ?? [];
  // Icon tints are stored once, keyed by display id or tool path, and set from the
  // Displays / Connect tabs — so a colour chosen there shows here too. Falling back
  // to the theme accent keeps every untinted tile consistent.
  const tintOf = (key: string) => ({ color: state.iconColors?.[key] || "var(--su-accent)" });

  return (
    <div className="flex flex-col h-[100dvh] overscroll-none kiosk-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* Brand top bar — same as the kiosk, minus the plan/context label. */}
      <div
        className="relative flex items-center h-10 shrink-0"
        style={
          {
            background: "rgba(0,0,0,0.50)",
            backdropFilter: "blur(20px)",
            borderBottom: "1px solid rgba(255,255,255,0.09)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 8px rgba(0,0,0,0.40)",
          } as React.CSSProperties
        }
      >
        <div className="shrink-0 ml-3 flex items-center gap-2 text-fg-muted relative z-10">
          {state.appLogo && (
            <BrandLogo
              logo={state.appLogo}
              monochrome={state.appLogoMonochrome}
              className="size-5 rounded select-none"
            />
          )}
          <span
            className="text-caption1 font-title select-none truncate"
            style={{ letterSpacing: "0.02em" }}
          >
            {state.appName}
          </span>
        </div>

        {state.showQr && state.remoteUrl && (
          <Tooltip label="Open settings in a new tab">
            <a
              href="/settings"
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 ml-auto mr-3 relative z-10 rounded transition-opacity hover:opacity-70"
              aria-label="Open settings in a new tab"
            >
              <QrHint url={state.remoteUrl} compact />
            </a>
          </Tooltip>
        )}
      </div>

      {/* Centered empty-slot image + display list. */}
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-8 px-6 py-8 overflow-y-auto overscroll-contain">
        {centerLogo && (
          <BrandLogo
            logo={centerLogo}
            monochrome
            className="text-fg-faint shrink-0"
            style={{ width: "clamp(6rem,22vmin,16rem)", height: "clamp(6rem,22vmin,16rem)" }}
          />
        )}

        <div className="flex flex-col gap-2 w-full max-w-xs">
          <span
            className="text-caption2 font-medium uppercase tracking-wider text-fg-subtle text-center select-none"
            style={{ letterSpacing: "0.08em" }}
          >
            Select a display
          </span>

          {displays.length === 0 ? (
            <p className="text-body text-gray-7 text-center">No displays configured.</p>
          ) : (
            displays.map((d) => (
              <a
                key={d.id}
                href={`/${d.id}`}
                className="flex items-center gap-3 su-card px-4 py-3 transition-colors hover:bg-white/10"
              >
                <MonitorIcon className="size-5 shrink-0" style={tintOf(d.id)} />
                <span className="text-body font-medium text-fg truncate">{d.name}</span>
                <ChevronRightIcon className="size-4 text-fg-faint ml-auto shrink-0" />
              </a>
            ))
          )}

          {/* Operator tools — not a display, but reachable here for convenience. */}
          <div className="my-1 h-px bg-white/10" />
          <a
            href="/scriptview"
            className="flex items-center gap-3 su-card px-4 py-3 transition-colors hover:bg-white/10"
          >
            <ListChecksIcon className="size-5 shrink-0" style={tintOf("/scriptview")} />
            <span className="text-body font-medium text-fg truncate">ScriptView</span>
            <ChevronRightIcon className="size-4 text-fg-faint ml-auto shrink-0" />
          </a>
          <a
            href="/baptism"
            className="flex items-center gap-3 su-card px-4 py-3 transition-colors hover:bg-white/10"
          >
            <DropletIcon className="size-5 shrink-0" style={tintOf("/baptism")} />
            <span className="text-body font-medium text-fg truncate">Baptisms</span>
            <ChevronRightIcon className="size-4 text-fg-faint ml-auto shrink-0" />
          </a>
          <a
            href="/patch"
            className="flex items-center gap-3 su-card px-4 py-3 transition-colors hover:bg-white/10"
          >
            <CableIcon className="size-5 shrink-0" style={tintOf("/patch")} />
            <span className="text-body font-medium text-fg truncate">Patch</span>
            <ChevronRightIcon className="size-4 text-fg-faint ml-auto shrink-0" />
          </a>
          {/* /log is deliberately absent — it's an operator diagnostic surface, not
              a volunteer destination. It's listed on Settings → Connect instead. */}
          <a
            href="/history"
            className="flex items-center gap-3 su-card px-4 py-3 transition-colors hover:bg-white/10"
          >
            <ClockIcon className="size-5 shrink-0" style={tintOf("/history")} />
            <span className="text-body font-medium text-fg truncate">Service history</span>
            <ChevronRightIcon className="size-4 text-fg-faint ml-auto shrink-0" />
          </a>
        </div>
      </div>
    </div>
  );
}
