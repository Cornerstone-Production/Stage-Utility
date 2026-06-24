import { Component, useEffect } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { onNotification } from "../lib/api";
import { SlotPanel } from "../components/slot-panel";
import { SlotsColumns } from "../components/slots-columns";
import { QrHint } from "../components/qr-hint";
import { BrandLogo } from "../components/brand-logo";
import { useStageState } from "./use-stage-state";
import { DashboardView } from "./dashboard-view";
import { StageDisplayView } from "./stage-display-view";
import { TranscriptionView } from "./transcription-view";
import { ScriptView } from "./script-view";
import { SplRundownView } from "./spl-rundown-view";
import { LayoutRenderer } from "./layout-renderer";
import { Loader2Icon, AlertCircleIcon, MonitorIcon } from "lucide-react";

// Resolve which display this kiosk window is showing. Prefers the clean path
// form (/display-1), falling back to the legacy ?display= query, then default.
function getDisplayId(): string {
  const slug = window.location.pathname.replace(/^\/+|\/+$/g, "");
  if (slug && slug !== "settings") return slug;
  return new URLSearchParams(window.location.search).get("display") ?? "display-1";
}

// ---- error boundary ---------------------------------------------------------

interface ErrorBoundaryState {
  error: Error | null;
}

class StageErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[StageView] render error", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-[100dvh] kiosk-surface gap-4">
          <AlertCircleIcon className="size-8 text-red-10" />
          <p className="text-headline text-gray-9">Display error — please reload</p>
          <p className="text-caption1 text-gray-7">{this.state.error.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---- kiosk top bar ----------------------------------------------------------

interface KioskTopBarProps {
  serviceTypeName: string | null;
  planSeriesTitle: string | null;
  planTitle: string | null;
  showQr: boolean;
  remoteUrl: string | null;
  /** Name of the current display, shown only when there are multiple displays */
  displayName?: string | null;
  /** Customizable brand name + logo (data URL). */
  appName: string;
  appLogo: string | null;
  appLogoMonochrome: boolean;
}

function KioskTopBar({
  serviceTypeName,
  planSeriesTitle,
  planTitle,
  showQr,
  remoteUrl,
  displayName,
  appName,
  appLogo,
  appLogoMonochrome,
}: KioskTopBarProps) {
  const service = serviceTypeName ?? "—";
  const event = planTitle ?? "No plan";
  const lead =
    planSeriesTitle && planSeriesTitle !== planTitle
      ? `${service} - ${planSeriesTitle}`
      : service;
  const contextLabel = `${lead}: ${event}`;

  return (
    <div
      className="relative flex items-center shrink-0"
      style={{
        // The whole bar scales with the display: `font-size` is the single knob,
        // children are sized in `em`, and the height tracks it. ~40px tall on a
        // 1080p screen, ~2× on a 4K (37") panel, scaling smoothly in between.
        fontSize: "clamp(0.78rem, 1.16vh, 1.5rem)",
        height: "3.3em",
        background: "rgba(0,0,0,0.50)",
        backdropFilter: "blur(20px) saturate(1.6)",
        borderBottom: "1px solid rgba(255,255,255,0.09)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 8px rgba(0,0,0,0.40)",
      } as React.CSSProperties}
    >
      {/* Brand + display name — one centered row so logo, name, divider and
          display name all share the same vertical center. */}
      <div className="shrink-0 flex items-center relative z-10" style={{ marginLeft: "1em", gap: "0.7em" }}>
        <a
          href="/"
          className="flex items-center text-white/70 rounded hover:opacity-80 transition-opacity"
          style={{ gap: "0.55em" }}
          title="Back to home"
          aria-label="Back to home"
        >
          {appLogo && (
            <BrandLogo
              logo={appLogo}
              monochrome={appLogoMonochrome}
              className="rounded select-none shrink-0"
              style={{ width: "1.55em", height: "1.55em" }}
            />
          )}
          <span
            className="font-title select-none truncate"
            style={{ fontSize: "1em", letterSpacing: "0.02em" }}
          >
            {appName}
          </span>
        </a>
        {displayName && (
          <>
            <span className="w-px bg-white/15 shrink-0" style={{ height: "1.3em" }} aria-hidden="true" />
            <span
              className="font-medium text-white/40 select-none truncate"
              style={{ fontSize: "0.92em", letterSpacing: "0.02em" }}
            >
              {displayName}
            </span>
          </>
        )}
      </div>

      <div className="absolute inset-0 flex items-center justify-center px-32 pointer-events-none max-sm:hidden">
        <span
          className="font-medium text-white/55 truncate select-none tracking-wide"
          style={{ fontSize: "1em", letterSpacing: "0.02em" }}
        >
          {contextLabel}
        </span>
      </div>

      {showQr && remoteUrl && (
        <a
          href="/settings"
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 ml-auto relative z-10 rounded transition-opacity hover:opacity-70"
          style={{ marginRight: "1em" }}
          title="Open settings"
          aria-label="Open settings"
        >
          <QrHint url={remoteUrl} compact sizeCss="clamp(1.75rem, 2.6vh, 3.5rem)" />
        </a>
      )}
    </div>
  );
}

// ---- loading / empty states -------------------------------------------------

function KioskLoading() {
  return (
    <div className="flex flex-col items-center justify-center h-[100dvh] kiosk-surface gap-3">
      <Loader2Icon className="size-8 text-gray-7 animate-spin" />
      <p className="text-headline text-gray-7">Loading stage…</p>
    </div>
  );
}

function KioskNotConfigured({ state, displayName }: { state: StageState; displayName: string | null }) {
  return (
    <div className="flex flex-col h-[100dvh] kiosk-surface">
      <KioskTopBar
        serviceTypeName={state.serviceTypeName}
        planSeriesTitle={state.planSeriesTitle}
        planTitle={state.planTitle}
        showQr={state.showQr}
        remoteUrl={state.remoteUrl}
        displayName={displayName}
        appName={state.appName}
        appLogo={state.appLogo}
        appLogoMonochrome={state.appLogoMonochrome}
      />
      <div className="flex flex-col items-center justify-center flex-1 gap-4 px-12 text-center">
        <MonitorIcon className="size-12 text-gray-7" />
        <p className="text-title3 text-gray-9 font-semibold">Planning Center not configured</p>
        <p className="text-body text-gray-7">
          Open Settings or scan the QR code from a phone to add your PCO credentials.
        </p>
      </div>
    </div>
  );
}

function KioskEmpty({ state, displayName }: { state: StageState; displayName: string | null }) {
  return (
    <div className="flex flex-col h-[100dvh] kiosk-surface">
      <KioskTopBar
        serviceTypeName={state.serviceTypeName}
        planSeriesTitle={state.planSeriesTitle}
        planTitle={state.planTitle}
        showQr={state.showQr}
        remoteUrl={state.remoteUrl}
        displayName={displayName}
        appName={state.appName}
        appLogo={state.appLogo}
        appLogoMonochrome={state.appLogoMonochrome}
      />
      <div className="flex flex-col items-center justify-center flex-1 gap-4 px-12 text-center">
        <MonitorIcon className="size-12 text-gray-7" />
        <p className="text-title3 text-gray-9 font-semibold">
          {state.planTitle ? state.planTitle : "No plan selected"}
        </p>
        <p className="text-body text-gray-7">No mic slots assigned yet. Add slots in Settings.</p>
      </div>
    </div>
  );
}

// Shown when an output exists but has no View routed to it.
function KioskUnrouted({ state, displayName }: { state: StageState; displayName: string | null }) {
  return (
    <div className="flex flex-col h-[100dvh] kiosk-surface">
      <KioskTopBar
        serviceTypeName={state.serviceTypeName}
        planSeriesTitle={state.planSeriesTitle}
        planTitle={state.planTitle}
        showQr={state.showQr}
        remoteUrl={state.remoteUrl}
        displayName={displayName}
        appName={state.appName}
        appLogo={state.appLogo}
        appLogoMonochrome={state.appLogoMonochrome}
      />
      <div className="flex flex-col items-center justify-center flex-1 gap-4 px-12 text-center">
        <MonitorIcon className="size-12 text-gray-7" />
        <p className="text-title3 text-gray-9 font-semibold">Display not configured</p>
        <p className="text-body text-gray-7">
          No view is assigned to this display. Assign one under Settings → Displays.
        </p>
      </div>
    </div>
  );
}

function KioskError({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-[100dvh] kiosk-surface gap-4 px-12 text-center">
      <AlertCircleIcon className="size-10 text-red-10" />
      <p className="text-title3 text-gray-9 font-semibold">Could not load stage state</p>
      <p className="text-caption1 text-gray-7">{message}</p>
    </div>
  );
}

// ---- main view --------------------------------------------------------------

export function StageView() {
  const { state, isLoading, error } = useStageState();
  const displayId = getDisplayId();

  // Keep the browser tab title in sync with the brand + this display's name, so
  // renaming a display (Settings) updates its kiosk tab too.
  const titleDisplay = (state?.outputs?.length ?? 0) > 1
    ? (state?.outputs?.find((o) => o.id === displayId)?.name ?? displayId)
    : null;
  useEffect(() => {
    const appName = state?.appName?.trim() || "Stage Utility";
    document.title = titleDisplay ? `${appName} — ${titleDisplay}` : appName;
  }, [state?.appName, titleDisplay]);

  // Remote refresh: reload this kiosk page when the server broadcasts a refresh
  // targeting this display (or "all"). Lets the operator push new content from
  // Settings without walking to the screen. Preview iframes are never reloaded.
  useEffect(() => {
    if (displayId.startsWith("preview-")) return;
    return onNotification("display:refresh", (payload: unknown) => {
      const target = (payload as { target?: string } | null)?.target ?? "all";
      if (target === "all" || target === displayId) window.location.reload();
    });
  }, [displayId]);

  if (isLoading) return <KioskLoading />;
  if (error) return <KioskError message={error} />;
  if (!state) return <KioskError message="State is unavailable." />;

  // Preview mode: a "/preview-<viewId>" slug renders a View's content directly,
  // regardless of any output routing (used by the settings live preview).
  const previewViewId = displayId.startsWith("preview-")
    ? displayId.slice("preview-".length)
    : null;
  const previewView = previewViewId
    ? (state.views?.find((v) => v.id === previewViewId) ?? null)
    : null;

  const multiDisplay = (state.outputs?.length ?? 0) > 1;
  const currentDisplay = previewViewId ? null : (state.displays?.find((d) => d.id === displayId) ?? null);
  const kind: ViewKind = previewView?.kind ?? currentDisplay?.kind ?? "slots";
  const displayName = previewView ? null : (multiDisplay ? (currentDisplay?.name ?? displayId) : null);

  // A real output (not a preview) with no View routed to it is unconfigured —
  // show a clear "no view assigned" screen rather than an empty slot grid.
  const resolved = previewViewId ? null : state.resolvedByOutput?.[displayId];

  // Blackout: a true black screen on command (Companion / Displays page), taking
  // priority over the routed View. Toggling it off restores the View instantly.
  if (!previewViewId && resolved?.blackout) {
    return <div className="fixed inset-0 z-50 bg-black" />;
  }

  const isUnrouted = !previewViewId && (!resolved || resolved.viewId === null);
  if (isUnrouted) {
    return (
      <StageErrorBoundary>
        <KioskUnrouted state={state} displayName={displayName} />
      </StageErrorBoundary>
    );
  }

  // Custom-layout views render the visual-editor layout below the same kiosk top
  // bar (brand + plan context + connect QR) the other views show.
  if (kind === "custom") {
    const activeView = previewView ?? (state.views?.find((v) => v.id === resolved?.viewId) ?? null);
    if (activeView?.layout) {
      return (
        <StageErrorBoundary>
          <div className="flex flex-col h-[100dvh] overflow-hidden kiosk-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
            <KioskTopBar
              serviceTypeName={state.serviceTypeName}
              planSeriesTitle={state.planSeriesTitle}
              planTitle={state.planTitle}
              showQr={state.showQr}
              remoteUrl={state.remoteUrl}
              displayName={displayName}
              appName={state.appName}
              appLogo={state.appLogo}
              appLogoMonochrome={state.appLogoMonochrome}
            />
            <div className="flex-1 min-h-0">
              {/* interactive only on a real display route — never in the
                  "/preview-…" iframe, so live-control objects can't fire PCO. */}
              <LayoutRenderer layout={activeView.layout} ndiSource={activeView.ndiSource ?? null} interactive={!previewViewId} />
            </div>
          </div>
        </StageErrorBoundary>
      );
    }
    return (
      <StageErrorBoundary>
        <KioskEmpty state={state} displayName={displayName} />
      </StageErrorBoundary>
    );
  }

  // Dashboard- and stage-kind displays render entirely different views.
  if (kind === "dashboard") {
    return (
      <StageErrorBoundary>
        <DashboardView displayId={displayId} />
      </StageErrorBoundary>
    );
  }
  if (kind === "stage") {
    return (
      <StageErrorBoundary>
        <StageDisplayView displayId={displayId} />
      </StageErrorBoundary>
    );
  }
  if (kind === "transcription") {
    return (
      <StageErrorBoundary>
        <TranscriptionView displayId={displayId} />
      </StageErrorBoundary>
    );
  }
  if (kind === "script") {
    const activeView = previewView ?? (state.views?.find((v) => v.id === resolved?.viewId) ?? null);
    return (
      <StageErrorBoundary>
        <ScriptView
          displayId={displayId}
          showLiveControls={(activeView?.showLiveControls ?? false) && !previewViewId}
        />
      </StageErrorBoundary>
    );
  }
  if (kind === "spl-rundown") {
    return (
      <StageErrorBoundary>
        <SplRundownView displayId={displayId} />
      </StageErrorBoundary>
    );
  }

  if (!state.pcoConfigured) {
    return (
      <StageErrorBoundary>
        <KioskNotConfigured state={state} displayName={displayName} />
      </StageErrorBoundary>
    );
  }

  // Slots-kind: a preview reads the View's slots directly; a real output reads
  // its own routed slots (no fallback to the primary display).
  const displaySlots = previewViewId
    ? (state.slotsByView?.[previewViewId] ?? [])
    : (state.slotsByDisplay?.[displayId] ?? []);
  const sortedSlots = [...displaySlots].sort((a, b) => a.order - b.order);

  // Physical alignment: when the View has a slotsLayout, columns are sized in
  // inches (against the monitor's active width) so they line up with the chargers.
  const slotsView = previewView ?? (state.views?.find((v) => v.id === resolved?.viewId) ?? null);
  const slotsLayout = slotsView?.slotsLayout ?? null;

  if (sortedSlots.length === 0) {
    return (
      <StageErrorBoundary>
        <KioskEmpty state={state} displayName={displayName} />
      </StageErrorBoundary>
    );
  }

  return (
    <StageErrorBoundary>
      <div className="flex flex-col h-[100dvh] overscroll-none overflow-hidden bg-transparent pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <KioskTopBar
          serviceTypeName={state.serviceTypeName}
          planSeriesTitle={state.planSeriesTitle}
          planTitle={state.planTitle}
          showQr={state.showQr}
          remoteUrl={state.remoteUrl}
          displayName={displayName}
          appName={state.appName}
          appLogo={state.appLogo}
          appLogoMonochrome={state.appLogoMonochrome}
        />
        {/* Desktop / kiosk: fill-height columns (stacked slots share a column).
            With a slotsLayout, columns are inch-sized and centered so they line up
            with the chargers; otherwise they share width equally. */}
        <SlotsColumns
          slots={sortedSlots}
          slotsLayout={slotsLayout}
          emptySlotLogo={state.emptySlotLogo}
          defaultAvatar={state.defaultAvatar}
          className="flex-1 max-sm:hidden"
        />

        {/* Phone: 2-up card grid, scrolls when it overflows (weekly-setup check).
            container-type makes the card's cqw-based sizing scale to the card. */}
        <div className="hidden max-sm:grid grid-cols-2 auto-rows-max content-start gap-2 p-2 flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {sortedSlots.filter((slot) => slot.link.kind !== "spacer").map((slot) => (
            <div key={slot.id} className="aspect-[3/4] flex [container-type:inline-size]">
              <SlotPanel slot={slot} emptySlotLogo={state.emptySlotLogo} defaultAvatar={state.defaultAvatar} overlay />
            </div>
          ))}
        </div>
      </div>
    </StageErrorBoundary>
  );
}
