import { Component, useEffect, useState } from "react";
import { Tooltip } from "../components/ui/tooltip";
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
import { capabilityLive, contextForOutput } from "./render-context";
import { viewSurface } from "@main/types/views";
import { Loader2Icon, AlertCircleIcon, MonitorIcon } from "lucide-react";
import { resolveDisplayId } from "./resolve-display";
import { resolveScreen, type StageScreen } from "./stage-screen";

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

// A "locked" kiosk (shared-link with ?kiosk=1) keeps the top bar for consistency
// but strips the escape hatches — the QR/settings link and the clickable home
// logo — so a handed-out link can't navigate away to settings or other displays.
// Soft by design (a savvy user could edit the URL); it's a guardrail, not auth.
function kioskLocked(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("kiosk") === "1";
  } catch {
    return false;
  }
}

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
  /** This output is locked (from its Displays-tab toggle) — strip the nav escape
   *  hatches even without the ?kiosk=1 URL override. */
  locked?: boolean;
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
  locked: lockedProp = false,
}: KioskTopBarProps) {
  const service = serviceTypeName ?? "—";
  const event = planTitle ?? "No plan";
  const lead =
    planSeriesTitle && planSeriesTitle !== planTitle
      ? `${service} - ${planSeriesTitle}`
      : service;
  const contextLabel = `${lead}: ${event}`;
  const locked = lockedProp || kioskLocked();

  // Brand logo + name; a link home only when unlocked (locked → plain, no navigation).
  const brandInner = (
    <>
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
    </>
  );

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
        backdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(255,255,255,0.09)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 8px rgba(0,0,0,0.40)",
      } as React.CSSProperties}
    >
      {/* Brand + display name — one centered row so logo, name, divider and
          display name all share the same vertical center. */}
      <div className="shrink-0 flex items-center relative z-10" style={{ marginLeft: "1em", gap: "0.7em" }}>
        {locked ? (
          <div className="flex items-center text-fg-muted" style={{ gap: "0.55em" }}>
            {brandInner}
          </div>
        ) : (
          <Tooltip label="Back to home">
            <a
              href="/"
              className="flex items-center text-fg-muted rounded hover:opacity-80 transition-opacity"
              style={{ gap: "0.55em" }}
              aria-label="Back to home"
            >
              {brandInner}
            </a>
          </Tooltip>
        )}
        {displayName && (
          <>
            <span className="w-px bg-white/15 shrink-0" style={{ height: "1.3em" }} aria-hidden="true" />
            <span
              className="font-medium text-fg-subtle select-none truncate"
              style={{ fontSize: "0.92em", letterSpacing: "0.02em" }}
            >
              {displayName}
            </span>
          </>
        )}
      </div>

      <div className="absolute inset-0 flex items-center justify-center px-32 pointer-events-none max-sm:hidden">
        <span
          className="font-medium text-fg-subtle truncate select-none tracking-wide"
          style={{ fontSize: "1em", letterSpacing: "0.02em" }}
        >
          {contextLabel}
        </span>
      </div>

      {showQr && remoteUrl && !locked && (
        <Tooltip label="Open settings in a new tab">
          <a
            href="/settings"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 ml-auto relative z-10 rounded transition-opacity hover:opacity-70"
            style={{ marginRight: "1em" }}
            aria-label="Open settings in a new tab"
          >
            <QrHint url={remoteUrl} compact sizeCss="clamp(1.75rem, 2.6vh, 3.5rem)" />
          </a>
        </Tooltip>
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

function KioskNotConfigured({ state, displayName, locked }: { state: StageState; displayName: string | null; locked?: boolean }) {
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
        locked={locked}
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

function KioskEmpty({ state, displayName, locked }: { state: StageState; displayName: string | null; locked?: boolean }) {
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
        locked={locked}
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
function KioskUnrouted({ state, displayName, locked }: { state: StageState; displayName: string | null; locked?: boolean }) {
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
        locked={locked}
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

// ---- live draft preview bridge ----------------------------------------------
// The settings Views page posts UNSAVED, already-resolved slot edits into this
// preview iframe so the preview reflects drafts live. Only "/preview-<id>"
// contexts honor these messages — a real display never sets previewViewId, so it
// ignores them entirely. Same-origin is enforced.
const PREVIEW_DRAFT_MSG = "stage-utility:preview-draft";
const PREVIEW_READY_MSG = "stage-utility:preview-ready";

function usePreviewDraftSlots(previewViewId: string | null): Slot[] | null {
  const [draft, setDraft] = useState<Slot[] | null>(null);
  useEffect(() => {
    if (!previewViewId) return;
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; viewId?: string; slots?: Slot[] | null } | null;
      if (data?.type === PREVIEW_DRAFT_MSG && data.viewId === previewViewId) {
        setDraft(Array.isArray(data.slots) ? data.slots : null);
      }
    }
    window.addEventListener("message", onMessage);
    // Tell the parent our listener is live, so it (re)posts the current draft.
    window.parent?.postMessage({ type: PREVIEW_READY_MSG, viewId: previewViewId }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, [previewViewId]);
  return previewViewId ? draft : null;
}

// ---- main view --------------------------------------------------------------

export function StageView() {
  const { state, isLoading, error } = useStageState();
  const pathSlug = getDisplayId();
  // A display may carry an optional friendly slug (/left-mic) alongside its
  // permanent id (/display-1). Resolve to the canonical id ONCE, here — everything
  // downstream (slotsByDisplay, resolvedByOutput, reload targeting) keys off the id,
  // so a slug must never reach them. Falling back to the raw path keeps every
  // pre-slug behavior intact, including the preview- prefix.
  const displayId = resolveDisplayId(pathSlug, state?.outputs) ?? pathSlug;
  // Preview slug → view id (null on a real display). Computed before any early
  // return so the draft-bridge hook is called unconditionally.
  const previewViewId = displayId.startsWith("preview-") ? displayId.slice("preview-".length) : null;
  const previewDraftSlots = usePreviewDraftSlots(previewViewId);

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

  // Presence heartbeat: tell the server this screen is alive so Settings → Displays
  // can show a Connected/Offline dot. Fast cadence near/during a PCO service, slow
  // otherwise (no point pinging every 20s during a dead week); a sendBeacon on unload
  // flips the dot offline at once, and the server TTL catches ungraceful deaths.
  useEffect(() => {
    if (displayId.startsWith("preview-")) return;
    const url = "/api/displays/presence";
    let near = false;
    let timer: ReturnType<typeof setInterval>;
    const ping = () => {
      void fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The size this screen is actually running at, so Screens can show it
        // without anybody walking to the wall with a laptop. CSS pixels plus the
        // ratio: that is what a layout is measured in, so it is the number that
        // answers "will my view fit".
        //
        // `device` comes from the /enroll redirect and is only present on a
        // kiosk device. A browser opened by hand has none, so its size is
        // reported by nobody and cannot overwrite the screen's.
        body: JSON.stringify({
          outputId: displayId,
          deviceId: new URLSearchParams(window.location.search).get("device") ?? undefined,
          screen: { w: window.screen.width, h: window.screen.height, dpr: window.devicePixelRatio },
        }),
        keepalive: true,
      }).catch(() => {});
    };
    const schedule = () => {
      clearInterval(timer);
      timer = setInterval(ping, near ? 20_000 : 60_000);
    };
    ping();
    schedule();
    const offLive = onNotification("pco:live", (p: unknown) => {
      const mode = (p as { mode?: string } | null)?.mode;
      const n = mode === "item" || mode === "preservice";
      if (n !== near) { near = n; schedule(); }
    });
    const leave = () => {
      try {
        navigator.sendBeacon?.(
          url,
          new Blob([JSON.stringify({ outputId: displayId, leaving: true })], { type: "application/json" }),
        );
      } catch { /* ignore */ }
    };
    window.addEventListener("pagehide", leave);
    return () => {
      clearInterval(timer);
      offLive();
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [displayId]);

  const screen = resolveScreen({ state, isLoading, error, displayId, previewViewId });

  // The three screens that draw nothing from the state, first — they are the only
  // ones reachable without one.
  if (screen.k === "loading") return <KioskLoading />;
  if (screen.k === "error") return <KioskError message={screen.message} />;
  // Blackout: a true black screen on command (Companion / Displays page), taking
  // priority over the routed View. Toggling it off restores the View instantly.
  if (screen.k === "blackout") return <div className="fixed inset-0 z-50 bg-black" />;
  // Unreachable: resolveScreen turns a missing state into the error screen above,
  // and every arm below draws the kiosk chrome from it. A guard rather than a
  // `state!` cast, so an invariant that ever does break says so on the wall
  // instead of leaving it dark.
  if (!state) return <KioskError message="State is unavailable." />;

  const body = ((): ReactNode => {
    switch (screen.k) {
      case "unrouted":
        return <KioskUnrouted state={state} displayName={screen.displayName} locked={screen.locked} />;
      case "not-configured":
        return <KioskNotConfigured state={state} displayName={screen.displayName} locked={screen.locked} />;
      case "empty":
        return <KioskEmpty state={state} displayName={screen.displayName} locked={screen.locked} />;
      case "view":
        return renderView(screen, state, previewViewId, previewDraftSlots);
      default: {
        const _never: never = screen;
        void _never;
        return null;
      }
    }
  })();

  return <StageErrorBoundary>{body}</StageErrorBoundary>;
}

/**
 * What a routed View draws, once resolveScreen has decided a View is what this
 * screen shows.
 *
 * A plain function rather than a component, so the rendered tree is exactly the
 * one the chain of returns produced — nothing new between the kiosk shell and
 * the view.
 */
function renderView(
  screen: Extract<StageScreen, { k: "view" }>,
  state: StageState,
  previewViewId: string | null,
  previewDraftSlots: Slot[] | null,
): ReactNode {
  const { kind, view: activeView, displayId, displayName, locked, isPreview, outputMode } = screen;

  switch (kind) {
    // Custom-layout views render the visual-editor layout below the same kiosk top
    // bar (brand + plan context + connect QR) the other views show.
    case "custom": {
      const layout = activeView?.layout;
      // resolveScreen sends a custom View with nothing drawn on it to the empty
      // screen, so a layout is always here. Falling back to that same screen keeps
      // an impossible state from going dark; it is not a second opinion about
      // what a blank custom View shows.
      if (!layout) return <KioskEmpty state={state} displayName={displayName} locked={locked} />;
      return (
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
            locked={locked}
          />
          <div className="flex-1 min-h-0">
            {/* Controls are live only where the operator deliberately made
                them so. A screen is a read-only display unless it was set to
                panel mode, and a "/preview-…" iframe is always a display —
                otherwise the Screens page could advance the service by being
                looked at, since every card renders one. */}
            <LayoutRenderer
              layout={layout}
              ndiSource={activeView?.ndiSource ?? null}
              interactive={capabilityLive(contextForOutput(outputMode, isPreview), "control")}
              surface={viewSurface(activeView)}
            />
          </div>
        </div>
      );
    }

    // Dashboard- and stage-kind displays render entirely different views.
    case "dashboard":
      return <DashboardView displayId={displayId} />;
    case "stage":
      return <StageDisplayView displayId={displayId} />;
    case "transcription":
      return <TranscriptionView displayId={displayId} />;
    case "script":
      return (
        // ScriptView sizes to h-full so it can also live inside a layout object;
        // the screen height and the safe-area insets belong to this route.
        <div className="h-[100dvh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
          <ScriptView scriptViewLayoutId={activeView?.scriptViewLayoutId ?? null} />
        </div>
      );
    case "spl-rundown":
      return <SplRundownView displayId={displayId} />;

    case "slots":
      break;
    default: {
      // Adding a ViewKind without an arm above fails the BUILD here. At runtime an
      // unrecognised kind still falls through to the slots path, exactly as the
      // chain of `if`s did — a newer server routing a kind this build predates
      // must not black out the screen.
      const _never: never = kind;
      void _never;
      break;
    }
  }

  // Slots-kind: a preview reads the View's slots directly; a real output reads
  // its own routed slots (no fallback to the primary display). In preview mode,
  // an unsaved draft pushed from the Views editor (already resolved) takes
  // precedence so edits show live; null draft falls back to saved state.
  const displaySlots = previewViewId
    ? (previewDraftSlots ?? state.slotsByView?.[previewViewId] ?? [])
    // Derived rather than read from a second copy: slotsByDisplay held exactly
    // slotsByView[thisOutput'sView], and shipping both put ~6 KB of duplicate slot
    // data in every state broadcast to every display.
    : (state.slotsByView?.[state.resolvedByOutput?.[displayId]?.viewId ?? ""] ?? []);
  const sortedSlots = [...displaySlots].sort((a, b) => a.order - b.order);

  // Physical alignment: when the View has a slotsLayout, columns are sized in
  // inches (against the monitor's active width) so they line up with the chargers.
  const slotsLayout = activeView?.slotsLayout ?? null;

  if (sortedSlots.length === 0) {
    return <KioskEmpty state={state} displayName={displayName} locked={locked} />;
  }

  return (
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
        locked={locked}
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
  );
}
