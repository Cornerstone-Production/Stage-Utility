import { Component, useEffect } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { SlotPanel } from "../components/slot-panel";
import { QrHint } from "../components/qr-hint";
import { BrandLogo } from "../components/brand-logo";
import { useStageState } from "./use-stage-state";
import { DashboardView } from "./dashboard-view";
import { StageDisplayView } from "./stage-display-view";
import { TranscriptionView } from "./transcription-view";
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
        <div className="flex flex-col items-center justify-center h-[100dvh] bg-[#080810] gap-4">
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
      className="relative flex items-center h-10 shrink-0"
      style={{
        background: "rgba(0,0,0,0.50)",
        backdropFilter: "blur(20px) saturate(1.6)",
        borderBottom: "1px solid rgba(255,255,255,0.09)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 8px rgba(0,0,0,0.40)",
      } as React.CSSProperties}
    >
      {/* Brand + display name — one centered row so logo, name, divider and
          display name all share the same vertical center. */}
      <div className="shrink-0 ml-3 flex items-center gap-2.5 relative z-10">
        <a
          href="/"
          className="flex items-center gap-2 text-white/70 rounded hover:opacity-80 transition-opacity"
          title="Back to home"
          aria-label="Back to home"
        >
          {appLogo && (
            <BrandLogo
              logo={appLogo}
              monochrome={appLogoMonochrome}
              className="size-5 rounded select-none"
            />
          )}
          <span
            className="text-caption1 font-title select-none truncate"
            style={{ letterSpacing: "0.02em" }}
          >
            {appName}
          </span>
        </a>
        {displayName && (
          <>
            <span className="w-px h-4 bg-white/15 shrink-0" aria-hidden="true" />
            <span
              className="text-caption1 font-medium text-white/40 select-none truncate"
              style={{ letterSpacing: "0.02em" }}
            >
              {displayName}
            </span>
          </>
        )}
      </div>

      <div className="absolute inset-0 flex items-center justify-center px-32 pointer-events-none max-sm:hidden">
        <span
          className="text-caption1 font-medium text-white/55 truncate select-none tracking-wide"
          style={{ letterSpacing: "0.02em" }}
        >
          {contextLabel}
        </span>
      </div>

      {showQr && remoteUrl && (
        <a
          href="/settings"
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 ml-auto mr-3 relative z-10 rounded transition-opacity hover:opacity-70"
          title="Open settings"
          aria-label="Open settings"
        >
          <QrHint url={remoteUrl} compact />
        </a>
      )}
    </div>
  );
}

// ---- loading / empty states -------------------------------------------------

function KioskLoading() {
  return (
    <div className="flex flex-col items-center justify-center h-[100dvh] bg-[#080810] gap-3">
      <Loader2Icon className="size-8 text-gray-7 animate-spin" />
      <p className="text-headline text-gray-7">Loading stage…</p>
    </div>
  );
}

function KioskNotConfigured({ state, displayName }: { state: StageState; displayName: string | null }) {
  return (
    <div className="flex flex-col h-[100dvh] bg-[#080810]">
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
    <div className="flex flex-col h-[100dvh] bg-[#080810]">
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
    <div className="flex flex-col h-[100dvh] bg-[#080810]">
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
    <div className="flex flex-col items-center justify-center h-[100dvh] bg-[#080810] gap-4 px-12 text-center">
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
  const titleDisplay = (state?.displays?.length ?? 0) > 1
    ? (state?.displays?.find((d) => d.id === displayId)?.name ?? displayId)
    : null;
  useEffect(() => {
    const appName = state?.appName?.trim() || "Stage Utility";
    document.title = titleDisplay ? `${appName} — ${titleDisplay}` : appName;
  }, [state?.appName, titleDisplay]);

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
  const isUnrouted = !previewViewId && (!resolved || resolved.viewId === null);
  if (isUnrouted) {
    return (
      <StageErrorBoundary>
        <KioskUnrouted state={state} displayName={displayName} />
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

  const columns: Slot[][] = [];
  for (const slot of sortedSlots) {
    if (slot.stackWithPrevious && columns.length > 0) {
      columns[columns.length - 1].push(slot);
    } else {
      columns.push([slot]);
    }
  }

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
        {/* Desktop / kiosk: fill-height columns (stacked slots share a column). */}
        <div className="flex flex-1 min-h-0 max-sm:hidden">
          {columns.map((column, ci) => (
            <div key={column[0]?.id ?? ci} className="flex flex-1 min-w-0 flex-col">
              {column.map((slot) => (
                <SlotPanel key={slot.id} slot={slot} emptySlotLogo={state.emptySlotLogo} />
              ))}
            </div>
          ))}
        </div>

        {/* Phone: 2-up card grid, scrolls when it overflows (weekly-setup check).
            container-type makes the card's cqw-based sizing scale to the card. */}
        <div className="hidden max-sm:grid grid-cols-2 auto-rows-max content-start gap-2 p-2 flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {sortedSlots.map((slot) => (
            <div key={slot.id} className="aspect-[3/4] flex [container-type:inline-size]">
              <SlotPanel slot={slot} emptySlotLogo={state.emptySlotLogo} />
            </div>
          ))}
        </div>
      </div>
    </StageErrorBoundary>
  );
}
