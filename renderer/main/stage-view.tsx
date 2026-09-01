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
import { CalendarView } from "./calendar-view";
import { LayoutRenderer } from "./layout-renderer";
import { capabilityLive, contextForOutput } from "./render-context";
import { viewSurface, KIND_DRAWS_TOP_BAR, type ViewKind } from "@main/types/views";
import { Loader2Icon, AlertCircleIcon, MonitorIcon } from "lucide-react";
import { resolveDisplayId } from "./resolve-display";
import { previewOutputId, previewViewIdFromSlug } from "./preview-url";
import { resolveScreen, type ScreenChrome, type StageScreen } from "./stage-screen";

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
          <p className="text-headline text-fg">Display error — please reload</p>
          <p className="text-caption1 text-fg-muted">{this.state.error.message}</p>
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
  /** This output is locked (from its Screens-page toggle) — strip the nav escape
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

/**
 * The kiosk top bar for a screen — or nothing at all, on a display whose
 * operator has hidden it.
 *
 * EVERY screen draws its bar through here. There were six render sites, each
 * repeating the same nine props off the state, and a per-display flag gated at
 * one of them would have left five walls still showing a bar the operator
 * turned off. One component, one gate: a seventh screen cannot draw an ungated
 * bar, because there is nothing else to draw.
 *
 * Returning null rather than hiding the bar is deliberate — every caller is a
 * flex column whose content is `flex-1`, so the strip is reclaimed rather than
 * left as a gap.
 */
function ScreenTopBar({ state, screen }: { state: StageState; screen: ScreenChrome }) {
  if (screen.hideTopBar) return null;
  return (
    <KioskTopBar
      serviceTypeName={state.serviceTypeName}
      planSeriesTitle={state.planSeriesTitle}
      planTitle={state.planTitle}
      showQr={state.showQr}
      remoteUrl={state.remoteUrl}
      displayName={screen.displayName}
      appName={state.appName}
      appLogo={state.appLogo}
      appLogoMonochrome={state.appLogoMonochrome}
      locked={screen.locked}
    />
  );
}

// ---- loading / empty states -------------------------------------------------

function KioskLoading() {
  return (
    <div className="flex flex-col items-center justify-center h-[100dvh] kiosk-surface gap-3">
      <Loader2Icon className="size-8 text-fg-subtle animate-spin" />
      <p className="text-headline text-fg-muted">Loading stage…</p>
    </div>
  );
}

function KioskNotConfigured({ state, screen }: { state: StageState; screen: ScreenChrome }) {
  return (
    <div className="flex flex-col h-[100dvh] kiosk-surface">
      <ScreenTopBar state={state} screen={screen} />
      <div className="flex flex-col items-center justify-center flex-1 gap-4 px-12 text-center">
        <MonitorIcon className="size-12 text-fg-subtle" />
        <p className="text-title3 text-fg font-semibold">Planning Center not configured</p>
        <p className="text-body text-fg-muted">
          Open Settings or scan the QR code from a phone to add your PCO credentials.
        </p>
      </div>
    </div>
  );
}

function KioskEmpty({ state, screen }: { state: StageState; screen: ScreenChrome }) {
  return (
    <div className="flex flex-col h-[100dvh] kiosk-surface">
      <ScreenTopBar state={state} screen={screen} />
      <div className="flex flex-col items-center justify-center flex-1 gap-4 px-12 text-center">
        <MonitorIcon className="size-12 text-fg-subtle" />
        <p className="text-title3 text-fg font-semibold">
          {state.planTitle ? state.planTitle : "No plan selected"}
        </p>
        <p className="text-body text-fg-muted">No mic slots assigned yet. Add slots in Settings.</p>
      </div>
    </div>
  );
}

// Shown when an output exists but has no View routed to it.
function KioskUnrouted({ state, screen }: { state: StageState; screen: ScreenChrome }) {
  return (
    <div className="flex flex-col h-[100dvh] kiosk-surface">
      <ScreenTopBar state={state} screen={screen} />
      <div className="flex flex-col items-center justify-center flex-1 gap-4 px-12 text-center">
        <MonitorIcon className="size-12 text-fg-subtle" />
        <p className="text-title3 text-fg font-semibold">Display not configured</p>
        <p className="text-body text-fg-muted">
          No view is assigned to this display. Assign one under Screens.
        </p>
      </div>
    </div>
  );
}

// Shown when a preview points at a View that no longer exists.
//
// Its own screen rather than the unrouted one: a view WAS chosen here, and
// saying "no view is assigned" would send the operator looking for a routing
// problem that is not there. Before this existed the same state fell through to
// the slots kind and drew an empty mic-slot grid, which said nothing at all.
// text-fg / text-fg-muted / text-fg-subtle throughout this file, never
// text-gray-*. The Radix gray scale follows the APP theme, which .kiosk-surface
// deliberately does not pin — its comment in styles.css records the 1.14:1 bug
// that made it pin --color-fg-* and nothing else. On the kiosk's near-black
// ground the dark scale measured text-gray-9 at 3.88:1 and text-gray-7 at
// 2.16:1, so every one of these screens said what was wrong in body copy nobody
// could read. The fg ramp is 16.67 / 9.71 / 4.50:1 and is inside the guarantee.
function KioskViewMissing({ state, screen }: { state: StageState; screen: ScreenChrome }) {
  return (
    <div className="flex flex-col h-[100dvh] kiosk-surface">
      <ScreenTopBar state={state} screen={screen} />
      <div className="flex flex-col items-center justify-center flex-1 gap-4 px-12 text-center">
        <MonitorIcon className="size-12 text-fg-subtle" />
        <p className="text-title3 text-fg font-semibold">View not found</p>
        <p className="text-body text-fg-muted">
          The view this preview points at has been deleted. Pick another under Screens.
        </p>
      </div>
    </div>
  );
}

/**
 * @param title what went wrong, in the operator's words. Defaults to the state
 *   failure this component was written for — and is a PARAMETER because it is
 *   now also reached when the state loaded perfectly and the view kind on it is
 *   one this build has never heard of. A wall display reading "Could not load
 *   stage state" sends somebody looking for a server problem that is not there.
 */
function KioskError({ message, title = "Could not load stage state" }: { message: string; title?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-[100dvh] kiosk-surface gap-4 px-12 text-center">
      <AlertCircleIcon className="size-10 text-red-10" />
      <p className="text-title3 text-fg font-semibold">{title}</p>
      <p className="text-caption1 text-fg-muted">{message}</p>
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

/**
 * The screen a full-page View is drawn on.
 *
 * Every one of these views sizes itself to h-full, because each also renders
 * inside an embed tile — so the viewport height and the safe-area insets belong
 * to the ROUTE, not to the component. Six kinds needed the identical wrapper;
 * this is it, rather than six copies to keep in step the next time a phone adds
 * an inset.
 *
 * It also owns the top bar for every kind it wraps, so that "does this kind get
 * a bar" is a lookup and not a per-arm decision. See KIND_DRAWS_TOP_BAR.
 */
function KioskFrame({
  state,
  screen,
  kind,
  children,
}: {
  state: StageState;
  screen: ScreenChrome;
  kind: ViewKind;
  children: ReactNode;
}) {
  // Whether this kind gets a bar is NOT decided here. KIND_DRAWS_TOP_BAR is the
  // one declaration; every kind routed through this frame obeys it, so turning a
  // kind's bar on is an edit to that map and not a seventh render site. The two
  // kinds with bespoke shells (slots, custom) read the same map, and
  // stage-view-paths.test.tsx renders all of them against it.
  if (!KIND_DRAWS_TOP_BAR[kind]) {
    return (
      <div className="h-[100dvh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        {children}
      </div>
    );
  }
  // The bar is a shrink-0 row over a flex-1 body — the same shape the custom
  // shell uses, so a view that sizes to h-full fills exactly what is left rather
  // than overflowing the viewport by the height of the bar.
  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <ScreenTopBar state={state} screen={screen} />
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

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
  const previewViewId = previewViewIdFromSlug(displayId);
  // Which screen this preview is a picture of, when it is a picture of one. See
  // preview-url.ts — the path names the View, so the Output has to ride beside it.
  const previewOutput = previewOutputId(window.location.search, previewViewId);
  const previewDraftSlots = usePreviewDraftSlots(previewViewId);

  // What this screen shows. Pure, and computed here rather than below the effects
  // so the tab title can read the same answer the top bar draws — this used to be
  // a second `outputs.find` with its own fallback, which is how the tab of a
  // preview came to be titled after the URL it was opened at.
  const screen = resolveScreen({
    state,
    isLoading,
    error,
    displayId,
    previewViewId,
    previewOutputId: previewOutput,
  });

  // Keep the browser tab title in sync with the brand + this display's name, so
  // renaming a display (Settings) updates its kiosk tab too.
  const titleDisplay = "displayName" in screen ? screen.displayName : null;
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

  // Presence heartbeat: tell the server this screen is alive so the Screens page
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

  // The three screens that draw nothing from the state, first — they are the only
  // ones reachable without one.
  if (screen.k === "loading") return <KioskLoading />;
  if (screen.k === "error") return <KioskError message={screen.message} />;
  // Not a state failure: the state loaded fine and this build simply cannot draw
  // the kind it names, so the wording has to say that rather than send somebody
  // looking for a server problem that is not there.
  if (screen.k === "unknown-kind") {
    return (
      <KioskError
        title="This build cannot draw this view"
        message={`The screen is routed to a "${screen.kind}" view, which this version does not know. Update this screen, or route it to another view.`}
      />
    );
  }
  // Blackout: a true black screen on command (Companion), taking
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
        return <KioskUnrouted state={state} screen={screen} />;
      case "view-missing":
        return <KioskViewMissing state={state} screen={screen} />;
      case "not-configured":
        return <KioskNotConfigured state={state} screen={screen} />;
      case "empty":
        return <KioskEmpty state={state} screen={screen} />;
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
  const { kind, view: activeView, displayId, isPreview, outputMode } = screen;

  switch (kind) {
    // Custom-layout views render the visual-editor layout below the same kiosk top
    // bar (brand + plan context + connect QR) the other views show.
    case "custom": {
      const layout = activeView?.layout;
      // resolveScreen sends a custom View with nothing drawn on it to the empty
      // screen, so a layout is always here. Falling back to that same screen keeps
      // an impossible state from going dark; it is not a second opinion about
      // what a blank custom View shows.
      if (!layout) return <KioskEmpty state={state} screen={screen} />;
      return (
        <div className="flex flex-col h-[100dvh] overflow-hidden kiosk-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
          <ScreenTopBar state={state} screen={screen} />
          <div className="flex-1 min-h-0">
            {/* Controls are live only where the operator deliberately made
                them so. A screen is a read-only display unless it was set to
                panel mode, and a "/preview-…" iframe is always a display —
                otherwise the Screens page could advance the service by being
                looked at, since every card renders one. */}
            <LayoutRenderer
              layout={layout}
              // The View this layout belongs to, which seeds the embed chain: an
              // embed tile inside it refuses to descend back into an ancestor,
              // and the presence channel opens only where a screen tile really
              // is. Null would read as "no ancestor" and lose both.
              viewId={activeView?.id ?? null}
              ndiSource={activeView?.ndiSource ?? null}
              interactive={capabilityLive(contextForOutput(outputMode, isPreview), "control")}
              surface={viewSurface(activeView)}
            />
          </div>
        </div>
      );
    }

    // Dashboard- and stage-kind displays render entirely different views. All
    // six size to h-full so they can also live inside an embed tile, so the
    // viewport height, the safe-area insets and the top bar come from
    // KioskFrame here — `kind={kind}` and not a literal, so an arm copied to
    // make the next one cannot silently claim its neighbour's bar setting.
    case "dashboard":
      return (
        <KioskFrame state={state} screen={screen} kind={kind}>
          <DashboardView displayId={displayId} />
        </KioskFrame>
      );
    case "stage":
      return (
        <KioskFrame state={state} screen={screen} kind={kind}>
          <StageDisplayView displayId={displayId} />
        </KioskFrame>
      );
    case "transcription":
      return (
        <KioskFrame state={state} screen={screen} kind={kind}>
          <TranscriptionView displayId={displayId} />
        </KioskFrame>
      );
    case "script":
      return (
        <KioskFrame state={state} screen={screen} kind={kind}>
          <ScriptView scriptViewLayoutId={activeView?.scriptViewLayoutId ?? null} />
        </KioskFrame>
      );
    case "spl-rundown":
      return (
        <KioskFrame state={state} screen={screen} kind={kind}>
          <SplRundownView displayId={displayId} />
        </KioskFrame>
      );

    case "calendar":
      return (
        <KioskFrame state={state} screen={screen} kind={kind}>
          {/* CalendarMonth sizes to h-full so the same component can live inside
              a layout object; the screen height and the safe-area insets belong
              to this route, which is what KioskFrame is.

              The View is the one resolveScreen already resolved -- a preview
              answers with its own, a real output with its routed one -- so this
              arm does not re-derive it the way the pre-resolver code did. */}
          <CalendarView
            viewId={activeView?.id ?? null}
            pcoConfigured={state.pcoConfigured ?? false}
            // The same answer every control on every surface uses. False on a
            // wall display, so it gets no chevrons and cannot be left on the
            // wrong month by a passer-by.
            interactive={capabilityLive(contextForOutput(outputMode, isPreview), "control")}
          />
        </KioskFrame>
      );

    case "slots":
      break;
    default: {
      // Adding a ViewKind without an arm above fails the BUILD here. An
      // unrecognised kind never reaches this function at runtime — resolveScreen
      // answers "unknown-kind" for one, and StageView draws the error before it
      // gets here — so there is nothing to fall through TO.
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
    return <KioskEmpty state={state} screen={screen} />;
  }

  return (
    <div className="flex flex-col h-[100dvh] overscroll-none overflow-hidden bg-transparent pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <ScreenTopBar state={state} screen={screen} />
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
