import { clamp } from "@main/services/clamp";
import { resolveLayout, type PlacedObject } from "./responsive-layout";
import { HomeCard, onlineFromState } from "../app/home/cards";
import { fitFor } from "./console-fit";
import { useState, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { segmentElapsedMs } from "@main/services/baptism-elapsed";
import { Tooltip } from "../components/ui/tooltip";
import { advancePeakHold, type PeakHold } from "./peak-hold.js";
import { useLatestRef } from "@renderer/lib/use-latest-ref";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { invoke } from "../lib/api";
import { BrandLogo } from "../components/brand-logo";
import { SlotsColumns } from "../components/slots-columns";
import { useDashboardState, usePropInstances } from "./use-dashboard-state";
import { useSplState, resolveSplValue } from "./use-spl-state";
import { useObsState } from "./use-obs-state";
import { useReaperState } from "./use-reaper-state";
import { useOscState, resolveOscActive } from "./use-osc-state";
import { usePeopleCountState, resolvePeopleValue, useServiceAvgOccupancy, useLiveServiceLow, useLiveServiceAttendance, useLiveServicePeaks } from "./use-people-count-state";
import { useBaptismState, summarizeBaptism, fmtClock } from "./use-baptism-state";
import { useIntegrations } from "./use-integration-states";
import { useWirelessChannels } from "./use-wireless-channels";
import { OscButton } from "./osc-button";
import { ActionButton } from "./action-button";
import { NotesObject, ChecklistObject } from "./notes-objects";
import { RossTalkButton } from "./rosstalk-button";
import { useTranscript } from "./use-transcript";
import { usePlanItems } from "./use-plan-items";
import { useServiceTimeline } from "./use-service-timeline";
import { computePcoTimer, fmtDuration } from "./pco-timer";
import { EMBED_FONT_FRACTION, isEmbeddableViewKind } from "./layout-objects";
import { ScriptView } from "./script-view";
import { channelLabel, lineColor } from "./channel-color";
import { TranscriptFeed } from "./transcript-feed";
import { LiveControls } from "./live-controls";
import { Loader2Icon, ZapIcon } from "lucide-react";

// Render context shared by every object renderer.
export interface LayoutRenderCtx {
  state: StageState;
  propresenter: ProPresenterStatusDTO | null;
  pcoLive: PcoLiveDTO | null;
  /** All configured ProPresenter instances + their status — for per-object
   *  instance selection (two-auditorium setups). null until loaded. */
  propInstances: PropInstancesDTO | null;
  /** Current PCO plan rundown (items + note categories) — for the service-order object. */
  planItems: PlanItemsDTO | null;
  transcript: TranscriptLineDTO[];
  spl: SplMetricsDTO | null;
  obs: ObsStatusDTO | null;
  reaper: ReaperStatusDTO | null;
  osc: OscFeedbackDTO | null;
  /** Global RossTalk simulate mode, so a button can show it is not really sending.
   *  Defaults to TRUE when unknown — the direction that cannot cause a stray send. */
  rosstalkSimulate?: boolean;
  /** Live SenSource Vea people counts — for the people-counter object. */
  peopleCount: PeopleCountDTO | null;
  /** Lowest in-room occupancy during the current/most-recent live service — the
   *  "Low" metric (replaces the useless whole-day minimum). null when none. */
  serviceLow: number | null;
  /** Per-service attendance for the current live service (baselined) — the
   *  "Attendance (this service)" metric, vs the day-total `peopleCount.attendance`. */
  serviceAttendance: number | null;
  /** This service's peaks, from the attendance record (not today's building peak). */
  servicePeak: number | null;
  servicePeakAttendance: number | null;
  /** Live baptism-timer state — for the baptism-timer object. */
  baptism: BaptismState | null;
  /** In-progress service timeline (planned vs actual item timing) — for the
   *  service-pacing object's whole-service scope. null when not recording. */
  serviceTimeline: ServiceTimeline | null;
  /** Live integration connection states + friendly labels — for the integration-status object. */
  integrations: IntegrationState[];
  integrationLabels: Record<string, string>;
  /** Flat wireless channel list — for the wireless-summary object. */
  wireless: DeviceStatus[];
  now: number;
  skewMs: number;
  ndiSource: string | null;
  /** Canvas height in design px — basis for fraction→px font/spacing sizing. */
  /** The canvas's own background colour, so a widget's opaque body matches it
   *  rather than hardcoding black. */
  canvasBg?: string | null;
  H: number;
  /** True only on a real display route. Interactive objects (live controls)
   *  only fire their commands when true — never in the editor or preview iframe. */
  interactive: boolean;
  /** Pixel placements when the layout is rendering responsively; absent when it
   *  is letterboxed, in which case objects position by percentage as before. */
  placed?: Map<string, PlacedObject>;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Box-level CSS (position handled by caller): background, border, radius,
 * padding, opacity, and flex alignment derived from text/vertical alignment.
 *
 * Phase 6 briefly replaced this with a fixed frame and culled the fields that
 * feed it. Reverted: the cull was right in principle and wrong in sequence —
 * the knobs came out before the widgets were good enough to not need them, and
 * the result looked worse than what it replaced. The fields are honoured again
 * until per-widget variants exist to replace them properly.
 */
export function boxStyle(o: LayoutObject, H: number, _canvasBg?: string | null): CSSProperties {
  const s = o.style ?? {};
  const css: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    justifyContent: s.vAlign === "top" ? "flex-start" : s.vAlign === "bottom" ? "flex-end" : "center",
    alignItems:
      s.textAlign === "left" ? "flex-start" : s.textAlign === "right" ? "flex-end" : "center",
    overflow: "hidden",
    // Border draws inside the box so it never changes the object's footprint.
    boxSizing: "border-box",
  };
  if (s.background) css.background = s.background;
  if (s.opacity != null) css.opacity = s.opacity;
  if (s.padding != null) css.padding = `${s.padding * H}px`;
  if (s.cornerRadius != null) css.borderRadius = `${s.cornerRadius * H}px`;
  // Clamp so a stray/legacy width can't swell into a solid fill.
  if (s.borderColor && s.borderWidth) css.border = `${Math.min(s.borderWidth, 0.04) * H}px solid ${s.borderColor}`;
  if (s.boxShadow) {
    const a = Math.min(1, s.boxShadow);
    css.boxShadow = `0 ${0.006 * a * H}px ${0.02 * a * H}px rgba(0,0,0,${0.45 * a}), 0 ${0.02 * a * H}px ${0.05 * a * H}px rgba(0,0,0,${0.30 * a})`;
  }
  if (o.config.type === "shape" && o.config.shape === "ellipse") css.borderRadius = "50%";
  return css;
}

/** Text-level CSS for the inner span. */
function textStyle(o: LayoutObject, H: number): CSSProperties {
  const s = o.style ?? {};
  const css: CSSProperties = {
    color: s.color ?? "#ffffff",
    fontSize: `${(s.fontSize ?? 0.05) * H}px`,
    fontWeight: s.fontWeight ?? 400,
    lineHeight: 1.1,
    textAlign: s.textAlign ?? "center",
    width: "100%",
  };
  if (s.italic) css.fontStyle = "italic";
  if (s.uppercase) css.textTransform = "uppercase";
  if (s.letterSpacing != null) css.letterSpacing = `${s.letterSpacing}em`;
  if (s.textShadow) {
    const a = Math.min(1, s.textShadow);
    css.textShadow = `0 ${0.004 * H}px ${0.012 * H}px rgba(0,0,0,${0.9 * a}), 0 ${0.01 * H}px ${0.03 * H}px rgba(0,0,0,${0.7 * a})`;
  }
  if (s.lineClamp) {
    css.display = "-webkit-box";
    css.WebkitBoxOrient = "vertical";
    css.WebkitLineClamp = s.lineClamp;
    css.overflow = "hidden";
  }
  return css;
}

function clockText(now: number, showSeconds: boolean, format: "12h" | "24h", showMeridiem: boolean): string {
  const d = new Date(now);
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  if (format === "12h") {
    const ampm = h < 12 ? "AM" : "PM";
    h = ((h + 11) % 12) + 1;
    return `${pad(h)}:${m}${showSeconds ? `:${s}` : ""}${showMeridiem ? ` ${ampm}` : ""}`;
  }
  return `${pad(h)}:${m}${showSeconds ? `:${s}` : ""}`;
}

/** Render one object (and, for containers, its children) as a positioned box.
 *  Position/size are PERCENT of the parent — because the wrapper is absolutely
 *  positioned, a child's % resolves against this box, so the same component
 *  renders correctly at any nesting depth. Font/radius/padding stay canvas-
 *  relative (boxStyle uses ctx.H = canvas height) regardless of depth. */
export function RenderObject({ o, ctx }: { o: LayoutObject; ctx: LayoutRenderCtx }) {
  const kids = o.children?.length
    ? [...o.children].filter((c) => !c.hidden).sort((a, b) => a.z - b.z)
    : null;
  // Responsive layouts are placed in absolute pixels by resolveLayout, which is
  // where anchors, aspect, clamps and stacking are decided. Everything else keeps
  // the percentage positioning it has always used — that is what makes the
  // default a no-op rather than a re-implementation of it.
  const placed = ctx.placed?.get(o.id);
  const geometry = placed
    ? {
        left: `${placed.left}px`,
        top: `${placed.top}px`,
        width: `${placed.width}px`,
        height: `${placed.height}px`,
      }
    : {
        left: `${o.x * 100}%`,
        top: `${o.y * 100}%`,
        width: `${o.w * 100}%`,
        height: `${o.h * 100}%`,
      };
  return (
    <div
      style={{
        position: "absolute",
        ...geometry,
        ...boxStyle(o, ctx.H, ctx.canvasBg),
      }}
    >
      {kids ? kids.map((c) => <RenderObject key={c.id} o={c} ctx={ctx} />) : <ObjectContent o={o} ctx={ctx} />}
    </div>
  );
}

/**
 * The "recording" fill state — a solid red block covering the whole object.
 *
 * ABSOLUTE, not width/height 100%. A normal child sized to 100% resolves against
 * the CONTENT box, so on an object with padding the red stopped short of its own
 * edges: the object's background and border went on drawing a ring around it, and
 * `borderRadius: inherit` gave the inner block the same absolute radius at a
 * smaller size, so the corners were not concentric either. How wrong it looked
 * therefore depended on the object's style, which is why a flat one looked right
 * and a padded one did not. Positioned this way it covers the padding too, and
 * the fill is the same shape as the object at any style.
 */
/**
 * Shrink whatever is inside so it fits the box, instead of spilling out of it.
 *
 * The measured sweep across every object type found eight that overflowed their
 * box at a normal dashboard tile size (259x161) — the status objects by up to
 * 48px, because a dot plus "OBS: Recording 00:12:34" is simply wider than a
 * narrow tile and nothing was shrinking it. Clipping is not the fix either: a
 * status the operator cannot read is the same as no status.
 *
 * Converges in a pass or two by back-deriving the natural size from the live
 * scroll size at the current scale. Floor of 0.3 so it degrades to "small" and
 * never to "invisible".
 */
/** How far a readout may grow beyond its designed size to fill its box. */
const FIT_MAX_GROWTH = 3;

function useFitScale<T extends HTMLElement = HTMLSpanElement>(deps: unknown[]): {
  wrapRef: React.RefObject<HTMLDivElement | null>;
  elRef: React.RefObject<T | null>;
  scale: number;
} {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const elRef = useRef<T | null>(null);
  const [scale, setScale] = useState(1);
  // The observer is subscribed once per dep change, so its callback would
  // otherwise close over a stale `scale`.
  const scaleRef = useLatestRef(scale);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const el = elRef.current;
    if (!wrap || !el) return;
    const measure = () => {
      const availW = wrap.clientWidth;
      const availH = wrap.clientHeight;
      if (availW <= 1 || availH <= 1) return;
      const cur = scaleRef.current;
      const natW = el.scrollWidth / cur;
      const natH = el.scrollHeight / cur;
      if (natW <= 0 || natH <= 0) return;
      // Grows as well as shrinks. The base size is a fraction of the CANVAS, so
      // capping at 1 meant a widget made twice as tall kept the same text and an
      // operator reached for the font-size field to fix it — which is precisely
      // the field this phase removes. Sizing from the widget's own box is what
      // makes that field unnecessary rather than merely unavailable.
      //
      // The ceiling stops a two-character readout in a large tile becoming
      // absurd, and the floor keeps a long string legible rather than vanishing.
      const desired = clamp(Math.min(availW / natW, availH / natH), 0.3, FIT_MAX_GROWTH);
      if (Math.abs(desired - cur) > 0.01) setScale(desired);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, scaleRef]);
  return { wrapRef, elRef, scale };
}

/**
 * The wrapper half of the fit: the box that is measured AGAINST.
 *
 * StatusDot and BaptismTimer carried byte-identical copies of this markup, which
 * is how a fix to the way things fit lands in one readout and misses the other.
 *
 * The wrapper and the scaled node must be different elements — measuring the
 * same node that shrinks makes it chase its own tail.
 */
function FitBox({
  ts,
  wrapRef,
  children,
}: {
  ts: CSSProperties;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={wrapRef}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent:
          ts.textAlign === "left" ? "flex-start" : ts.textAlign === "right" ? "flex-end" : "center",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

function RecordingFill({ label, ts }: { label: string; ts: CSSProperties }) {
  const basePx = parseFloat(String(ts.fontSize)) || 16;
  const { wrapRef, elRef, scale } = useFitScale([label, basePx, ts.fontWeight]);
  return (
    <div
      ref={wrapRef}
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--red-9)",
        borderRadius: "inherit",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // A long label (a record timecode pushes it wider) shrinks to fit; the
        // clip stays as the backstop for the pathological case.
        overflow: "hidden",
      }}
    >
      <span
        ref={elRef}
        style={{ ...ts, color: "#ffffff", width: undefined, maxWidth: "100%", fontSize: `${basePx * scale}px` }}
      >
        {label}
      </span>
    </div>
  );
}

/** Render one object's inner content (the positioned box wraps this). */
// Format a signed pacing delta — over plan reads "+M:SS", under reads "−M:SS".
function fmtSignedDuration(sec: number): string {
  const s = Math.round(sec);
  if (s === 0) return "0:00";
  return `${s > 0 ? "+" : "−"}${fmtDuration(Math.abs(s))}`;
}

// 0–5 RF bars as filled/empty blocks, for the wireless-channel tile.
function rfBarsGlyph(bars: number): string {
  const n = clamp(Math.round(bars), 0, 5);
  return "▮".repeat(n) + "▯".repeat(5 - n);
}

/** The neutral dot: an integration that is not connected, a recorder that is idle. */
const DOT_IDLE = "rgba(255,255,255,0.35)";

/**
 * A status dot with its label, sized in em so it tracks the object's font.
 *
 * Shared so the connection objects and the recording objects cannot drift into
 * looking like two different conventions — a dot on a stage display means one
 * thing, and it should be the same shape and size wherever it appears.
 */
function StatusDot({
  color,
  label,
  ts,
  dimmed = false,
}: {
  color: string;
  label?: string | null;
  ts: CSSProperties;
  dimmed?: boolean;
}) {
  const basePx = parseFloat(String(ts.fontSize)) || 16;
  const { wrapRef, elRef, scale } = useFitScale([label, basePx, ts.fontWeight]);
  return (
    <FitBox ts={ts} wrapRef={wrapRef}>
      <span
        ref={elRef}
        style={{
          ...ts,
          width: "auto",
          maxWidth: "100%",
          fontSize: `${basePx * scale}px`,
          display: "inline-flex",
          alignItems: "center",
          gap: "0.4em",
          opacity: dimmed ? 0.4 : 1,
        }}
      >
        <span
          style={{ width: "0.6em", height: "0.6em", borderRadius: "50%", background: color, flexShrink: 0 }}
        />
        {label ? <span>{label}</span> : null}
      </span>
    </FitBox>
  );
}

// Shrinks the font so `text` fits its box (width + height) instead of clipping —
// used by single-value text objects (current/next item) where a long title would
// otherwise overflow. Converges in a pass or two by back-deriving the natural size
// from the live scroll size (same approach as ServiceOrderObject's auto-fit).
function FitText({ text, ts, vAlign }: { text: string; ts: CSSProperties; vAlign?: LayoutVAlign }) {
  const basePx = parseFloat(String(ts.fontSize)) || 16;
  // Same measurement as the status objects — one implementation, so a fix to how
  // things fit their box cannot land in one of them and miss the others.
  const { wrapRef, elRef, scale } = useFitScale([text, basePx, ts.fontWeight]);
  const justify = vAlign === "top" ? "flex-start" : vAlign === "bottom" ? "flex-end" : "center";
  const align = ts.textAlign === "left" ? "flex-start" : ts.textAlign === "right" ? "flex-end" : "center";
  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: justify, alignItems: align, overflow: "hidden" }}>
      <span ref={elRef} style={{ ...ts, width: undefined, maxWidth: "100%", display: "inline-block", fontSize: `${basePx * scale}px` }}>{text}</span>
    </div>
  );
}


/** Seconds until the next service, or null. Same source as the context bar. */
function homeSecondsToStart(ctx: LayoutRenderCtx): number | null {
  const t = computePcoTimer(ctx.pcoLive, ctx.now, ctx.skewMs);
  return t && !t.over ? t.seconds : null;
}

export function ObjectContent({ o, ctx }: { o: LayoutObject; ctx: LayoutRenderCtx }) {
  const c = o.config;
  const ts = textStyle(o, ctx.H);
  // Every readout fits its box. This helper backs the plain-text objects
  // (text, slide text, slide notes), and routing it through FitText is what
  // makes a per-object font size unnecessary rather than merely unfashionable.
  const span = (text: string) => <FitText text={text} ts={ts} vAlign={o.style?.vAlign} />;

  switch (c.type) {
    case "text":
      return span(c.text);
    case "clock":
      // FitText, not a bare span: "2:26:41 PM" is 4px wider than a 257px tile,
      // and a clock that spills past its own box on a dashboard is the single
      // most visible version of this bug.
      return (
        <FitText
          text={clockText(ctx.now, c.showSeconds ?? true, c.format ?? "12h", c.showMeridiem ?? true)}
          ts={ts}
          vAlign={o.style?.vAlign}
        />
      );
    case "countdown-timer": {
      const t = computePcoTimer(ctx.pcoLive, ctx.now, ctx.skewMs);
      if (!t) return (c.hideWhenIdle ?? false) ? null : span("—");
      // Red once the timer goes negative (item or service ran over), like the
      // dashboard; amber once it drops to/below the configured warning; else keep
      // the object's configured color.
      const warning = c.warnSeconds != null && !t.over && t.seconds <= c.warnSeconds;
      const color = t.over ? "var(--red-10)" : warning ? "var(--yellow-10)" : null;
      return (
        <FitText text={fmtDuration(t.seconds)} ts={color ? { ...ts, color } : ts} vAlign={o.style?.vAlign} />
      );
    }
    case "service-pacing": {
      // Live cumulative drift: how far ahead/behind the whole schedule we are
      // right NOW. actualElapsed (wall-clock since the service began) minus the
      // planned position (sum of planned lengths of finished items + the live
      // item's elapsed, capped at its planned length). Result carries slippage
      // from earlier items and only grows "behind" once the current item runs
      // past its plan. Negative = ahead (green), positive = behind (red).
      const tol = 3; // within ±3s of plan reads "0:00"
      const serverNow = ctx.now + ctx.skewMs;
      let deltaSec: number | null = null;
      const tl = ctx.serviceTimeline;
      if (tl) {
        // Counted items only — exclude pre-service/buffer padding (a per-item
        // override wins, else default to not-pre-service), mirroring History.
        const items = tl.items.filter((it) => (typeof it.counted === "boolean" ? it.counted : !(it.preService ?? false)));
        const startMs = items[0]?.startedAt ? Date.parse(items[0].startedAt) : NaN;
        let plannedElapsed = 0;
        let live: { startedAt: string; plannedLengthSec: number | null } | null = null;
        for (const it of items) {
          // Finished items add their planned length; an item PCO gave no planned
          // time falls back to its actual so it reads neutral (not "behind").
          if (it.endedAt != null) plannedElapsed += it.plannedLengthSec ?? it.actualDurationSec ?? 0;
          else if (it.startedAt) live = it;
        }
        if (live && Number.isFinite(startMs)) {
          const liveElapsed = Math.max(0, (serverNow - Date.parse(live.startedAt)) / 1000);
          const livePlanned = live.plannedLengthSec ?? liveElapsed;
          plannedElapsed += Math.min(liveElapsed, livePlanned);
          deltaSec = (serverNow - startMs) / 1000 - plannedElapsed;
        }
      }
      if (deltaSec == null) return (c.hideWhenIdle ?? false) ? null : <span style={{ ...ts, opacity: 0.4 }}>—</span>;
      const behind = deltaSec > tol;
      const ahead = deltaSec < -tol;
      const color = behind ? c.behindColor ?? "var(--red-10)" : ahead ? c.aheadColor ?? "var(--green-10)" : null;
      const text = !behind && !ahead ? "0:00" : fmtSignedDuration(deltaSec);
      return (
        <span style={color ? { ...ts, color } : ts}>
          {text}
          {(c.showLabel ?? false) && (behind || ahead) && <span style={{ opacity: 0.6, fontSize: "0.6em" }}>{behind ? " behind" : " ahead"}</span>}
        </span>
      );
    }
    case "current-slide-text": {
      const pro = c.propresenterInstanceId ? ctx.propInstances?.status[c.propresenterInstanceId] : ctx.propresenter;
      return span(pro?.currentSlideText ?? pro?.currentItem ?? "");
    }
    case "next-slide-text": {
      const pro = c.propresenterInstanceId ? ctx.propInstances?.status[c.propresenterInstanceId] : ctx.propresenter;
      return span(pro?.nextSlideText ?? pro?.nextItem ?? "");
    }
    case "current-service-item": {
      // Follow the PCO plan order (authoritative); fall back to ProPresenter's
      // active playlist only when PCO has no current item. Auto-fit so a long title
      // shrinks to the box instead of clipping.
      const pro = c.propresenterInstanceId ? ctx.propInstances?.status[c.propresenterInstanceId] : ctx.propresenter;
      return <FitText text={ctx.pcoLive?.currentItemTitle ?? pro?.currentServiceItem ?? ""} ts={ts} vAlign={o.style?.vAlign} />;
    }
    case "next-service-item": {
      const pro = c.propresenterInstanceId ? ctx.propInstances?.status[c.propresenterInstanceId] : ctx.propresenter;
      return <FitText text={ctx.pcoLive?.nextItemTitle ?? pro?.nextServiceItem ?? ""} ts={ts} vAlign={o.style?.vAlign} />;
    }
    case "service-order":
      return <ServiceOrderObject o={o} config={c} ctx={ctx} />;
    case "view-embed":
      return <ViewEmbedObject o={o} config={c} ctx={ctx} />;
    case "current-slide-notes": {
      const pro = c.propresenterInstanceId ? ctx.propInstances?.status[c.propresenterInstanceId] : ctx.propresenter;
      return span(pro?.currentNotes ?? "");
    }
    case "section-chip": {
      const pro = c.propresenterInstanceId ? ctx.propInstances?.status[c.propresenterInstanceId] : ctx.propresenter;
      const sec =
        c.which === "next"
          ? pro?.nextSection
          : c.which === "nextArrangement"
            ? pro?.nextArrangementSection
            : pro?.currentSection;
      if (!sec) return null;
      return (
        <span
          style={{
            ...ts,
            width: "auto",
            background: sec.colorHex,
            color: "#fff",
            padding: `${0.01 * ctx.H}px ${0.025 * ctx.H}px`,
            borderRadius: `${0.5 * (o.style?.fontSize ?? 0.05) * ctx.H}px`,
          }}
        >
          {sec.name}
        </span>
      );
    }
    case "pp-timer": {
      const pro = c.propresenterInstanceId ? ctx.propInstances?.status[c.propresenterInstanceId] : ctx.propresenter;
      const timers = pro?.timers ?? [];
      const timer = c.timerName ? timers.find((t) => t.name === c.timerName) : timers[0];
      if (!timer) return (c.hideWhenIdle ?? false) ? null : <span style={{ ...ts, opacity: 0.4 }}>—</span>;
      // Color only on clearly-expired states; unknown/other states stay neutral.
      const state = (timer.state ?? "").toLowerCase();
      const danger = state.includes("over") || state.includes("expire");
      const color = (c.warnStates ?? true) && danger ? "var(--red-10)" : null;
      return (
        <span style={color ? { ...ts, color } : ts}>
          {(c.showLabel ?? true) && timer.name && <span style={{ opacity: 0.6, fontSize: "0.6em" }}>{`${timer.name} `}</span>}
          {timer.time}
        </span>
      );
    }
    case "slide-progress": {
      const pro = c.propresenterInstanceId ? ctx.propInstances?.status[c.propresenterInstanceId] : ctx.propresenter;
      const idx = pro?.slideIndex ?? null;
      const count = pro?.slideCount ?? null;
      const remaining = pro?.slidesRemaining ?? null;
      const display = c.display ?? "fraction";
      if (display === "bar") {
        if (idx == null || !count) return <span style={{ ...ts, opacity: 0.4 }}>—</span>;
        const pct = Math.min(100, Math.round((idx / count) * 100));
        return (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center" }}>
            <div style={{ width: "100%", height: `${0.02 * ctx.H}px`, background: "rgba(255,255,255,0.15)", borderRadius: 999, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: ts.color ?? "#fff", borderRadius: 999 }} />
            </div>
          </div>
        );
      }
      let text: string;
      if (display === "remaining") text = remaining != null ? `${remaining} left` : "—";
      else if (display === "percent") text = count && count > 0 && idx != null ? `${Math.round((idx / count) * 100)}%` : "—";
      else text = idx != null && count != null ? `${idx} / ${count}` : "—";
      const dim = text === "—";
      return (
        <span style={dim ? { ...ts, opacity: 0.4 } : ts}>
          {text}
          {(c.showLabel ?? false) && !dim && <span style={{ opacity: 0.6, fontSize: "0.6em" }}> slides</span>}
        </span>
      );
    }
    case "slide-thumbnail": {
      const pro = c.propresenterInstanceId ? ctx.propInstances?.status[c.propresenterInstanceId] : ctx.propresenter;
      const key = pro?.slidePreviewKey;
      if (!key) return null;
      const inst =
        c.propresenterInstanceId && c.propresenterInstanceId !== "default"
          ? `&i=${encodeURIComponent(c.propresenterInstanceId)}`
          : "";
      return (
        <img
          src={`/api/propresenter/thumbnail?k=${encodeURIComponent(key)}${inst}`}
          alt="Slide preview"
          className="w-full h-full object-contain"
          draggable={false}
        />
      );
    }
    case "transcript-strip": {
      // Optionally drop lines from hidden channels (by channel name).
      const hidden = c.hideChannels ?? [];
      const lines = hidden.length
        ? ctx.transcript.filter((l) => !hidden.includes(l.channelName ?? ""))
        : ctx.transcript;
      if (lines.length === 0) return null;
      if (c.mode !== "latest") {
        // Multi-speaker feed that mirrors the dedicated captions display: newest
        // line at the BOTTOM, older shifting up, LEFT-aligned (captions read left,
        // not centered). Sized to this object's box; maxLines unset = show as many
        // as fit (older clipped at the top, exactly like the full display).
        return (
          <TranscriptFeed
            lines={lines}
            maxLines={c.maxLines}
            showLabels
            colorOverrides={ctx.state.captionChannelColors}
            textStyle={{ ...ts, textAlign: "left" }}
            gapClassName="gap-[0.3em]"
            className="w-full h-full"
          />
        );
      }
      const last = lines[lines.length - 1];
      const speaker = channelLabel(last);
      return (
        <span style={{ ...ts, color: lineColor(last, ctx.state.captionChannelColors), opacity: last.isFinal ? 1 : 0.55 }}>
          {speaker ? `${speaker}: ${last.text}` : last.text}
        </span>
      );
    }
    case "live-controls":
      // PCO Services Live Prev/Next. Only wired up on a real display; in the
      // editor/preview it renders the same buttons but they don't fire.
      return (
        <div className={ctx.interactive ? "w-full h-full" : "w-full h-full pointer-events-none"}>
          <LiveControls className="w-full h-full" />
        </div>
      );
    case "brand-logo": {
      const logo = c.useEmptySlotLogo ? ctx.state.emptySlotLogo : ctx.state.appLogo;
      if (logo) {
        return (
          <BrandLogo
            logo={logo}
            monochrome={!c.useEmptySlotLogo && ctx.state.appLogoMonochrome}
            className="w-full h-full"
            style={{ objectFit: "contain" }}
          />
        );
      }
      return span(ctx.state.appName);
    }
    case "image":
      return c.src ? (
        <img src={c.src} alt="" className="w-full h-full object-contain" draggable={false} />
      ) : (
        <span style={{ ...ts, color: "rgba(255,255,255,0.3)" }}>Image</span>
      );
    case "plan-attachment":
      return (
        <PlanAttachment
          match={c.match ?? "stage plot"}
          page={c.page ?? 1}
          crop={c.crop}
          trim={c.trim}
          background={c.background}
          planId={ctx.state.planId}
          H={ctx.H}
        />
      );
    case "shape":
      return null; // the box background is the shape
    case "container":
      return null; // the box is drawn by the wrapper; children render recursively
    case "ndi-video":
      return (
        <div className="flex flex-col items-center justify-center w-full h-full bg-black/60 text-white/40">
          <span style={{ fontSize: `${0.03 * ctx.H}px` }}>NDI</span>
          <span style={{ fontSize: `${0.022 * ctx.H}px` }}>{ctx.ndiSource || "no source"}</span>
        </div>
      );
    case "slots-grid": {
      // Inline: this object owns its slots (resolved by object id). Otherwise:
      // embed an existing slots-View's resolved grid by sourceViewId.
      const inline = c.source === "inline";
      const slots = inline
        ? (ctx.state.slotsByLayoutObject?.[o.id] ?? [])
        : c.sourceViewId
          ? (ctx.state.slotsByView?.[c.sourceViewId] ?? [])
          : [];
      if (slots.length === 0) {
        return <span style={{ ...ts, color: "rgba(255,255,255,0.3)" }}>Mic slots</span>;
      }
      // Render via the same component the standalone slots view uses, honoring the
      // physical-inch alignment (the object's own when inline, else the source
      // View's), over the kiosk backdrop so it looks identical.
      const slotsLayout = inline
        ? (c.slotsLayout ?? null)
        : (c.sourceViewId ? (ctx.state.views?.find((v) => v.id === c.sourceViewId)?.slotsLayout ?? null) : null);
      return (
        <SlotsColumns
          slots={slots}
          slotsLayout={slotsLayout}
          emptySlotLogo={ctx.state.emptySlotLogo}
          defaultAvatar={ctx.state.defaultAvatar}
          className="w-full h-full kiosk-surface"
        />
      );
    }
    case "charger-battery":
      return <ChargerBattery config={c} all={ctx.state.chargerBays ?? []} H={ctx.H} baseStyle={ts} />;
    case "spl-meter":
      return <SplMeterValue config={c} spl={ctx.spl} ts={ts} />;
    case "people-counter": {
      const metric = c.metric ?? "attendance";
      // "min" = lowest in-room during the live service; "serviceAttendance" = entered
      // THIS service (baselined) — both from the attendance record. "attendance" is
      // the building's day total. Everything else comes from the live people counts.
      const value =
        metric === "min" ? ctx.serviceLow
        : metric === "serviceAttendance" ? ctx.serviceAttendance
        : metric === "servicePeak" ? ctx.servicePeak
        : metric === "servicePeakAttendance" ? ctx.servicePeakAttendance
        : resolvePeopleValue(ctx.peopleCount, metric, c.zoneId);
      if (value == null) return <span style={{ ...ts, opacity: 0.4 }}>—</span>;
      const fallbackLabel =
        metric === "occupancy" ? "in room" : metric === "peak" ? "peak att." : metric === "min" ? "low" : metric === "avg" ? "avg att." : metric === "serviceAttendance" ? "svc entries" : metric === "servicePeak" ? "svc peak" : metric === "servicePeakAttendance" ? "svc peak att." : "entries";
      return (
        <span style={ts}>
          {value.toLocaleString()}
          {c.showLabel && (
            <span style={{ opacity: 0.6, fontSize: "0.6em" }}>
              {` ${c.label ?? fallbackLabel}`}
            </span>
          )}
        </span>
      );
    }
    case "people-graph":
      return <PeopleGraphObject ctx={ctx} config={c} ts={ts} />;
    case "people-panel":
      return <PeoplePanel config={c} people={ctx.peopleCount} serviceLow={ctx.serviceLow} serviceAttendance={ctx.serviceAttendance} servicePeak={ctx.servicePeak} servicePeakAttendance={ctx.servicePeakAttendance} ts={ts} H={ctx.H} />;
    case "baptism-timer":
      return <BaptismTimer state={ctx.baptism} config={c} ts={ts} now={ctx.now} />;
    case "record-status": {
      // "Is anything recording?" — one indicator regardless of which recorder the
      // campus uses, so a layout survives a switch from OBS to REAPER unchanged.
      const src = c.source ?? "any";
      const obsRec = ctx.obs?.recording ?? false;
      const reaRec = ctx.reaper?.recording ?? false;
      const obsUp = ctx.obs?.connected ?? false;
      const reaUp = ctx.reaper?.connected ?? false;
      const active = src === "obs" ? obsRec : src === "reaper" ? reaRec : obsRec || reaRec;
      // "Connected" for `any` means at least one recorder is reachable — otherwise a
      // dim badge would claim "not recording" when nothing can actually report.
      const connected = src === "obs" ? obsUp : src === "reaper" ? reaUp : obsUp || reaUp;

      if (!active && (c.hideWhenIdle ?? false)) return null;

      if (active) {
        const label = c.recordingText ?? "RECORDING";
        // Same fill as the OBS and REAPER objects — a child sized 100% resolves
        // against the content box, so on a padded object the red stopped short of
        // its own edges.
        if (c.fillWhenRecording ?? true) return <RecordingFill label={label} ts={ts} />;
        // Not filling the box: same dot convention as the connection objects, so
        // a red dot always means the same thing wherever it appears on a display.
        return <StatusDot color="var(--red-10)" label={label} ts={ts} />;
      }
      // Idle: dim when offline so a neutral badge is never mistaken for "not
      // recording" when no recorder is reachable at all.
      return (
        <StatusDot
          color={DOT_IDLE}
          label={connected ? (c.idleText ?? "STANDBY") : (c.offlineText ?? "NO RECORDER")}
          ts={ts}
          dimmed={!connected}
        />
      );
    }
    case "obs-status": {
      const obs = ctx.obs;
      const connected = obs?.connected ?? false;
      const mode = c.mode ?? "recording";
      const active =
        mode === "streaming" ? (obs?.streaming ?? false)
        : mode === "virtualcam" ? (obs?.virtualCam ?? false)
        : (obs?.recording ?? false);
      // Pure tally-light mode: nothing on screen unless the chosen output is active.
      if (!active && (c.hideWhenIdle ?? false)) return null;
      // Per-mode default labels (overridable via the *Text fields).
      const activeDefault = mode === "streaming" ? "OBS: Streaming" : mode === "virtualcam" ? "OBS: Virtual Cam" : "OBS: Recording";
      const idleDefault = mode === "streaming" ? "OBS: Stream off" : mode === "virtualcam" ? "OBS: Cam off" : "OBS: Standby";
      if (active) {
        // Timecode is the record duration — only meaningful in recording mode.
        const tc = mode === "recording" && c.showTimecode && obs?.recordTimecode ? ` ${obs.recordTimecode}` : "";
        const label = `${c.recordingText ?? activeDefault}${tc}`;
        // Fill the whole box red (a strong room cue) or just color the text.
        if (c.fillWhenRecording ?? true) return <RecordingFill label={label} ts={ts} />;
        // Not filling the box: same dot convention as the connection objects, so
        // a red dot always means the same thing wherever it appears on a display.
        return <StatusDot color="var(--red-10)" label={label} ts={ts} />;
      }
      // Idle: dim when offline so a neutral badge is never mistaken for "not
      // active" when OBS is merely unreachable.
      return (
        <StatusDot
          color={DOT_IDLE}
          label={connected ? (c.idleText ?? idleDefault) : (c.offlineText ?? "OBS: Offline")}
          ts={ts}
          dimmed={!connected}
        />
      );
    }
    case "reaper-status": {
      const reaper = ctx.reaper;
      const connected = reaper?.connected ?? false;
      const recording = reaper?.recording ?? false;
      // Pure tally-light mode: nothing on screen unless REAPER is recording.
      if (!recording && (c.hideWhenIdle ?? false)) return null;
      if (recording) {
        // Position ticks while recording — trim REAPER's ".mmm" to whole seconds.
        const posRaw = reaper?.positionString ?? "";
        const dot = posRaw.indexOf(".");
        const pos = c.showPosition && posRaw ? ` ${dot === -1 ? posRaw : posRaw.slice(0, dot)}` : "";
        const label = `${c.recordingText ?? "REAPER: Recording"}${pos}`;
        // Fill the whole box red (a strong room cue) or just color the text.
        if (c.fillWhenRecording ?? true) return <RecordingFill label={label} ts={ts} />;
        // Not filling the box: same dot convention as the connection objects, so
        // a red dot always means the same thing wherever it appears on a display.
        return <StatusDot color="var(--red-10)" label={label} ts={ts} />;
      }
      // Idle: dim when offline so a neutral badge is never mistaken for "not
      // recording" when REAPER is merely unreachable.
      return (
        <StatusDot
          color={DOT_IDLE}
          label={connected ? (c.idleText ?? "REAPER: Standby") : (c.offlineText ?? "REAPER: Offline")}
          ts={ts}
          dimmed={!connected}
        />
      );
    }
    case "rosstalk-button":
      return (
        <RossTalkButton
          config={c}
          interactive={ctx.interactive ?? false}
          simulate={ctx.rosstalkSimulate ?? true}
          ts={ts}
        />
      );
    case "notes":
      return (
        <NotesObject
          objectId={o.id}
          config={c}
          editable={ctx.interactive}
          all={ctx.state?.notesByObject}
          ts={ts}
        />
      );
    case "checklist":
      return (
        <ChecklistObject
          objectId={o.id}
          config={c}
          editable={ctx.interactive}
          all={ctx.state?.notesByObject}
          ts={ts}
        />
      );
    case "action-button":
      return <ActionButton config={c} interactive={ctx.interactive} ts={ts} />;
    case "osc-button":
      return (
        <OscButton
          config={c}
          active={resolveOscActive(ctx.osc, c.targetId ?? null, c.feedback)}
          interactive={ctx.interactive}
          ts={ts}
        />
      );
    case "integration-status": {
      const st = c.integrationId ? ctx.integrations.find((i) => i.id === c.integrationId) : ctx.integrations[0];
      const conn = st?.connection ?? "disconnected";
      const dot =
        conn === "connected" ? "var(--green-10)"
        : conn === "error" ? "var(--red-10)"
        : conn === "connecting" ? "var(--yellow-10)"
        : DOT_IDLE;
      const name = c.label ?? (st ? (ctx.integrationLabels[st.id] ?? st.id) : "—");
      return <StatusDot color={dot} label={(c.showLabel ?? true) ? name : null} ts={ts} />;
    }
    case "wireless-summary": {
      const ch = ctx.wireless;
      if (ch.length === 0) return <span style={{ ...ts, opacity: 0.4 }}>—</span>;
      const online = ch.filter((d) => d.online).length;
      const batteries = ch.filter((d) => d.online && d.battery != null).map((d) => d.battery as number);
      const lowest = batteries.length ? Math.min(...batteries) : null;
      const showOnline = c.showOnline ?? true;
      const showBattery = c.showBattery ?? true;
      const prefix = (c.showLabel ?? false) && c.label ? `${c.label} ` : "";
      return (
        <span style={{ ...ts, width: "auto", display: "inline-flex", alignItems: "baseline", gap: "0.4em" }}>
          {prefix && <span>{prefix.trim()}</span>}
          {showOnline && <span>{online}/{ch.length}</span>}
          {showBattery && lowest != null && (
            <span style={{ color: batteryColor(lowest) }}>{lowest}%</span>
          )}
        </span>
      );
    }
    case "wireless-channel": {
      const d = c.channelId ? ctx.wireless.find((x) => x.channelId === c.channelId) : ctx.wireless[0];
      if (!d) return <span style={{ ...ts, opacity: 0.4 }}>—</span>;
      const show = c.show ?? { rf: true, battery: true, frequency: true };
      return (
        <div style={{ ...ts, opacity: d.online ? 1 : 0.4, display: "flex", flexDirection: "column", justifyContent: "center", width: "100%", height: "100%" }}>
          {(c.showLabel ?? true) && <span style={{ fontSize: "0.55em", opacity: 0.65 }}>{d.name ?? d.channelId}</span>}
          <span style={{ display: "inline-flex", gap: "0.5em", alignItems: "baseline", flexWrap: "wrap" }}>
            {show.rf && d.rfBars != null && <span>{rfBarsGlyph(d.rfBars)}</span>}
            {show.battery && d.battery != null && <span style={{ color: batteryColor(d.battery) }}>{d.battery}%</span>}
            {show.frequency && d.frequencyLabel && <span style={{ opacity: 0.7 }}>{d.frequencyLabel}</span>}
            {show.audio && d.audioLevel != null && <span style={{ opacity: 0.7 }}>{Math.round(d.audioLevel * 100)}%</span>}
          </span>
        </div>
      );
    }
    // Home's cards. They render the SAME components Home's fixed panel does, so
    // the editable Home and the built-in one cannot drift into looking like two
    // different products.
    case "home-readiness":
    case "home-next-service":
    case "home-recent-services":
    case "home-live-status":
      // pointer-events-none, ALWAYS — not gated on ctx.interactive like
      // live-controls is.
      //
      // Three of these four cards contain in-app links (/screens, /history) put
      // there for Home, which runs in the operator shell. Every OTHER surface
      // that renders them — a wall display, a panel, the editor preview — is on
      // the kiosk router, whose whole route table is "/". A touch on the SPL
      // stat took a display to a "Route not found" page and left it there until
      // somebody walked over and reloaded it.
      //
      // Their capability is ["readout"], with no drill-down, so a link that does
      // nothing off the shell is what the model already says they are. Home
      // renders them directly, not through here, and keeps its links.
      return (
        <div className="w-full h-full pointer-events-none">
          <HomeCard
            type={c.type}
            state={ctx.state}
            pcoLive={ctx.pcoLive}
            now={ctx.now}
            skewMs={ctx.skewMs}
            // From the state snapshot, not a presence hook — see onlineFromState.
            onlineOutputIds={onlineFromState(ctx.state)}
            secondsToStart={homeSecondsToStart(ctx)}
          />
        </div>
      );
    default: {
      // Exhaustiveness guard: every LayoutObjectType must have a case above. Add
      // a type to the registry without a renderer here and this assignment stops
      // compiling, instead of the object silently rendering as an empty box on a
      // stage monitor. (Runtime still returns null — an older layout may hold a
      // type this build has since dropped.)
      const _never: never = c;
      void _never;
      return null;
    }
  }
}

// Live SPL readout. With `peakHold`, shows the highest value seen for the
// selected meter/metric (held in a ref across the ~250ms broadcasts), resetting
// when the selected meter/metric changes; otherwise shows the live reading.
function SplMeterValue({
  config,
  spl,
  ts,
}: {
  config: Extract<LayoutObjectConfig, { type: "spl-meter" }>;
  spl: SplMetricsDTO | null;
  ts: CSSProperties;
}) {
  const r = resolveSplValue(spl, config.meterId, config.metricKey);
  // Peak hold is a running max over samples, so it has to survive renders — but it
  // must also rise on the very render a louder sample lands, or the meter reads a
  // frame behind the room. Advanced during render for that reason; see peak-hold.ts
  // for why the step is written to be idempotent.
  const holdKey = `${config.meterId ?? ""}|${config.metricKey ?? ""}|${config.peakHold ? "1" : "0"}`;
  const [hold, setHold] = useState<PeakHold>({ key: holdKey, peak: null });
  const nextHold = advancePeakHold(hold, holdKey, r?.value ?? null, !!config.peakHold);
  if (nextHold !== hold) setHold(nextHold);

  const shown = config.peakHold ? nextHold.peak : (r?.value ?? null);
  if (shown == null) return <span style={{ ...ts, opacity: 0.4 }}>— dB</span>;
  const color = splThresholdColor(shown, config.thresholds);
  return (
    <span style={color ? { ...ts, color } : ts}>
      {`${Math.round(shown)} dB`}
      {config.peakHold && <span style={{ opacity: 0.6, fontSize: "0.6em" }}> pk</span>}
      {config.showLabel && r && <span style={{ opacity: 0.6, fontSize: "0.6em" }}>{` ${r.metricKey}`}</span>}
    </span>
  );
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** A "nice" integer axis step (1 / 2 / 5 × 10ⁿ, minimum 1) for a target interval
 *  size. Keeps gridline labels round at any scale — 1, 2, 5 … up to thousands. */
function niceStepInt(target: number): number {
  const x = target > 1 ? target : 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / pow;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(1, Math.round(m * pow));
}

// A sparkline of the building-total people count over the rolling history.
// The filled area + line live in a 0–100 viewBox stretched to the object box
// (non-scaling stroke keeps the line crisp at any aspect); axis labels are crisp
// HTML overlays. Y-axis auto-scales to nice round integer bounds (1/2/5 ×10ⁿ) that
// expand with the data — no cap, so it grows to thousands — with headroom (so a
// spike never clips) and three distinct labels; x-axis shows the first/last sample.
/** Fetch a recorded service's per-service curve + PCO markers for the people-graph
 *  "recorded" mode. serviceKey null → most recent finished service. */
function useRecordedGraph(enabled: boolean, serviceKey: string | null | undefined) {
  const [data, setData] = useState<{ points: PeopleHistoryPoint[]; markers: { t: string; label: string }[]; serviceStartedAt: string | null; serviceEndedAt: string | null } | null>(null);
  useResyncOn([enabled], () => {
    if (!enabled) setData(null);
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      let key = serviceKey ?? null;
      if (!key) {
        const list = await invoke<ServiceAttendance[]>("attendance:listHistory").catch(() => [] as ServiceAttendance[]);
        key = (list ?? []).filter((s) => s.endedAt).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]?.serviceKey ?? null;
      }
      if (!key) { if (!cancelled) setData({ points: [], markers: [], serviceStartedAt: null, serviceEndedAt: null }); return; }
      const [att, tl] = await Promise.all([
        invoke<ServiceAttendance | null>("attendance:getHistory", { serviceKey: key }).catch(() => null),
        invoke<ServiceTimeline | null>("serviceTimeline:get", { serviceKey: key }).catch(() => null),
      ]);
      if (cancelled) return;
      const base = att?.samples?.[0]?.attendance ?? 0; // per-service anchor
      const points: PeopleHistoryPoint[] = (att?.samples ?? []).map((s) => ({ t: s.t, attendance: Math.max(0, s.attendance - base), occupancy: s.occupancy }));
      const markers = (tl?.items ?? []).filter((it) => it.title && it.startedAt).map((it) => ({ t: it.startedAt, label: it.title }));
      setData({ points, markers, serviceStartedAt: att?.serviceStartedAt ?? null, serviceEndedAt: att?.endedAt ?? null });
    })();
    return () => { cancelled = true; };
  }, [enabled, serviceKey]);
  return data;
}

/** People-graph object: live rolling window or a recorded service's curve, with a
 *  kiosk live/recorded toggle, PCO-item markers, and a hover tooltip. */
function PeopleGraphObject({ ctx, config, ts }: { ctx: LayoutRenderCtx; config: Extract<LayoutObjectConfig, { type: "people-graph" }>; ts: CSSProperties }) {
  const cfgSource = config.source ?? "live";
  const [mode, setMode] = useState<"live" | "recorded">(cfgSource);
  useResyncOn([cfgSource], () => setMode(cfgSource));
  const recorded = useRecordedGraph(mode === "recorded", config.recordedServiceKey);
  const liveMarkers = (ctx.serviceTimeline?.items ?? []).filter((it) => it.title && it.startedAt).map((it) => ({ t: it.startedAt, label: it.title }));
  const points = mode === "recorded" ? (recorded?.points ?? []) : (ctx.peopleCount?.history ?? []);
  const markers = mode === "recorded" ? (recorded?.markers ?? []) : liveMarkers;
  return (
    <PeopleGraph
      history={points}
      metric={config.metric ?? "occupancy"}
      config={config}
      markers={config.showMarkers !== false ? markers : []}
      showTooltip={config.showTooltip !== false}
      ts={ts}
      H={ctx.H}
      serviceStartedAt={mode === "recorded" ? (recorded?.serviceStartedAt ?? null) : null}
      serviceEndedAt={mode === "recorded" ? (recorded?.serviceEndedAt ?? null) : null}
      toggle={config.kioskToggle && ctx.interactive ? { mode, onToggle: () => setMode((m) => (m === "live" ? "recorded" : "live")) } : null}
    />
  );
}

function PeopleGraph({
  history,
  metric,
  config,
  markers = [],
  showTooltip = true,
  toggle = null,
  ts,
  H,
  serviceStartedAt = null,
  serviceEndedAt = null,
}: {
  history: PeopleHistoryPoint[];
  metric: "attendance" | "occupancy";
  config: Extract<LayoutObjectConfig, { type: "people-graph" }>;
  markers?: { t: string; label: string }[];
  showTooltip?: boolean;
  toggle?: { mode: "live" | "recorded"; onToggle: () => void } | null;
  ts: CSSProperties;
  H: number;
  /** Service-proper window (recorded mode) — dims the arrival ramp / emptying-room taper. */
  serviceStartedAt?: string | null;
  serviceEndedAt?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const vals = history.map((h) => (metric === "attendance" ? h.attendance : h.occupancy));
  if (vals.length < 2) {
    return (
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <span style={{ ...ts, opacity: 0.4 }}>{toggle?.mode === "recorded" ? "no recorded data" : "—"}</span>
        {toggle && <GraphToggle mode={toggle.mode} onToggle={toggle.onToggle} stroke={ts.color ?? "#fff"} H={H} />}
      </div>
    );
  }
  const n = vals.length;
  const stroke = ts.color ?? "#ffffff";

  // Auto-scaling integer bounds. People counts can be a handful or thousands, so
  // pick a "nice" integer step (1/2/5 ×10ⁿ) sized to the data and EXPAND to fit —
  // no cap, so a packed 2,500-seat room scales up on its own. Three DISTINCT round
  // gridline labels with headroom above the peak (the old fixed rounding could print
  // duplicates like "2, 2, 1" on a 0–1 range).
  const dataMin = Math.min(...vals);
  const dataMax = Math.max(...vals);
  let step = niceStepInt((dataMax - dataMin) / 2);
  let lo = Math.max(0, Math.floor(dataMin / step) * step);
  let hi = lo + 2 * step;
  // Grow the step until the peak fits strictly below the top (keeps the line off the
  // top edge and the labels round), recomputing lo so it stays on a step boundary.
  while (hi <= dataMax) {
    step = niceStepInt(step + 1);
    lo = Math.max(0, Math.floor(dataMin / step) * step);
    hi = lo + 2 * step;
  }
  const range = hi - lo;
  const mid = lo + step;

  // Plot rect inside the 0–100 box: leave room for y labels (left) + x labels (bottom).
  const PADL = 13, PADR = 2, PADT = 9, PADB = 16;
  const px = (i: number) => PADL + (i / (n - 1)) * (100 - PADL - PADR);
  const py = (v: number) => PADT + (1 - (v - lo) / range) * (100 - PADT - PADB);
  const line = vals.map((v, i) => `${px(i).toFixed(2)},${py(v).toFixed(2)}`).join(" ");
  const fontPx = Math.max(7, 0.035 * H);
  const yLabel = (v: number): string => Math.round(v).toLocaleString();
  const labelStyle = (top: string): CSSProperties => ({
    position: "absolute", left: 0, top, transform: "translateY(-50%)",
    color: stroke, opacity: 0.7, fontSize: `${fontPx}px`, lineHeight: 1, fontWeight: 600,
  });
  const yTop = `${PADT}%`, yMidPct = `${PADT + (100 - PADT - PADB) / 2}%`, yBot = `${100 - PADB}%`;

  // PCO markers: snap each item's time to the nearest sample index, then to plot X.
  const times = history.map((h) => Date.parse(h.t));
  const t0 = times[0], tN = times[n - 1];
  const nearestIdx = (ms: number): number => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(times[i] - ms); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  const markerPts = markers
    .map((m) => ({ label: m.label, ms: Date.parse(m.t), t: m.t }))
    .filter((m) => Number.isFinite(m.ms) && m.ms >= t0 - 1000 && m.ms <= tN + 1000)
    .map((m) => { const idx = nearestIdx(m.ms); return { ...m, idx, x: px(idx) }; });
  // Autosize marker labels: full size up to ~6 markers, then scale down (floored)
  // so a busy plan's rotated names stay legible without overlapping.
  const markerFont = Math.max(6, fontPx * 0.85 * (markerPts.length > 6 ? 6 / markerPts.length : 1));

  // Service-proper band (recorded mode): dim the arrival ramp / emptying-room taper
  // outside it so the service itself reads as the main event.
  const bandX0 = serviceStartedAt && Number.isFinite(Date.parse(serviceStartedAt)) ? px(nearestIdx(Date.parse(serviceStartedAt))) : null;
  const bandX1 = serviceEndedAt && Number.isFinite(Date.parse(serviceEndedAt)) ? px(nearestIdx(Date.parse(serviceEndedAt))) : null;
  const hasPre = bandX0 != null && bandX0 > PADL + 0.5;
  const hasPost = bandX1 != null && bandX1 < 100 - PADR - 0.5;
  // PCO item times for the x-axis — thinned left→right so close items don't crowd
  // (the item NAME stays on the vertical marker line; only the time drops to the axis).
  const axisMarkers: { x: number; t: string }[] = [];
  let lastAxisX = -Infinity;
  for (const m of [...markerPts].sort((a, b) => a.x - b.x)) {
    if (m.x - lastAxisX >= 8 && m.x > PADL + 4 && m.x < 100 - PADR - 4) {
      axisMarkers.push({ x: m.x, t: m.t });
      lastAxisX = m.x;
    }
  }

  // Hover: map pointer X (over the full-width box) back to the nearest sample index.
  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const el = wrapRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const vbX = ((e.clientX - r.left) / r.width) * 100;
    const frac = (vbX - PADL) / (100 - PADL - PADR);
    setHover(clamp(Math.round(frac * (n - 1)), 0, n - 1));
  }
  // Guard the hover index against the current series: switching live↔recorded swaps
  // the data under a stale index, so clamp it out rather than indexing undefined.
  const hIdx = hover != null && hover >= 0 && hover < n ? hover : null;
  const hoverX = hIdx != null ? px(hIdx) : 0;
  const nearMarker = hIdx != null ? markerPts.find((m) => m.idx === hIdx) : undefined;

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}
      onPointerMove={showTooltip ? onMove : undefined}
      onPointerLeave={showTooltip ? () => setHover(null) : undefined}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block" }}>
        {/* gridlines at lo / mid / hi */}
        {[PADT, PADT + (100 - PADT - PADB) / 2, 100 - PADB].map((y, i) => (
          <line key={i} x1={PADL} y1={y} x2={100 - PADR} y2={y} stroke={stroke} strokeOpacity={0.18} strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
        ))}
        <polygon points={`${PADL},${100 - PADB} ${line} ${100 - PADR},${100 - PADB}`} fill={stroke} fillOpacity={0.13} />
        <polyline points={line} fill="none" stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        {/* dim the pre-service ramp / post-service taper outside the service band */}
        {hasPre && <rect x={PADL} y={PADT} width={(bandX0 as number) - PADL} height={100 - PADT - PADB} fill="rgba(0,0,0,0.32)" />}
        {hasPost && <rect x={bandX1 as number} y={PADT} width={100 - PADR - (bandX1 as number)} height={100 - PADT - PADB} fill="rgba(0,0,0,0.32)" />}
        {hasPre && <line x1={bandX0 as number} y1={PADT} x2={bandX0 as number} y2={100 - PADB} stroke={stroke} strokeOpacity={0.5} strokeWidth={0.6} strokeDasharray="1.5 1.5" vectorEffect="non-scaling-stroke" />}
        {hasPost && <line x1={bandX1 as number} y1={PADT} x2={bandX1 as number} y2={100 - PADB} stroke={stroke} strokeOpacity={0.5} strokeWidth={0.6} strokeDasharray="1.5 1.5" vectorEffect="non-scaling-stroke" />}
        {/* PCO plan-item markers */}
        {markerPts.map((m, i) => (
          <line key={i} x1={m.x} y1={PADT} x2={m.x} y2={100 - PADB} stroke={stroke} strokeOpacity={0.4} strokeWidth={0.75} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
        ))}
        {/* hover crosshair (the round point is an HTML overlay — a <circle> would
            stretch to an ellipse under preserveAspectRatio="none") */}
        {hIdx != null && (
          <line x1={hoverX} y1={PADT} x2={hoverX} y2={100 - PADB} stroke={stroke} strokeOpacity={0.55} strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
        )}
      </svg>

      {/* y-axis value labels (crisp HTML overlays) */}
      <span style={labelStyle(yTop)}>{yLabel(hi)}</span>
      <span style={labelStyle(yMidPct)}>{yLabel(mid)}</span>
      <span style={labelStyle(yBot)}>{yLabel(lo)}</span>

      {/* x-axis time labels — endpoints + thinned PCO item times */}
      <span style={{ position: "absolute", left: `${PADL}%`, bottom: 0, color: stroke, opacity: 0.7, fontSize: `${fontPx}px`, lineHeight: 1 }}>{hhmm(history[0].t)}</span>
      <span style={{ position: "absolute", right: `${PADR}%`, bottom: 0, color: stroke, opacity: 0.7, fontSize: `${fontPx}px`, lineHeight: 1 }}>{hhmm(history[n - 1].t)}</span>
      {axisMarkers.map((m, i) => (
        <span
          key={`axt-${i}`}
          style={{
            position: "absolute", left: `${m.x}%`, bottom: 0, transform: "translateX(-50%)",
            color: stroke, opacity: 0.55, fontSize: `${markerFont}px`, lineHeight: 1,
            whiteSpace: "nowrap", pointerEvents: "none",
          }}
        >
          {hhmm(m.t)}
        </span>
      ))}

      {/* current value readout (top-right; drops below the toggle when both show) */}
      {config.showLabel && (
        <span style={{ position: "absolute", top: toggle ? `${0.05 * H}px` : 0, right: `${PADR}%`, color: stroke, fontSize: `${fontPx * 1.3}px`, fontWeight: 700, lineHeight: 1, opacity: 0.95 }}>
          {(config.label ? `${config.label} ` : "") + vals[n - 1].toLocaleString()}
        </span>
      )}

      {/* PCO marker labels — the item NAME rotated on its line (time is on the x-axis),
          shrunk as markers get dense (denser plan → smaller type, floored). */}
      {markerPts.map((m, i) => (
        <span
          key={i}
          style={{
            position: "absolute", left: `${m.x}%`, top: `${PADT}%`,
            transform: "translate(-50%, -50%) rotate(-90deg)", transformOrigin: "center",
            color: stroke, opacity: 0.7, fontSize: `${markerFont}px`, lineHeight: 1,
            fontWeight: 600, whiteSpace: "nowrap", pointerEvents: "none",
            maxWidth: `${0.32 * H}px`, overflow: "hidden", textOverflow: "ellipsis",
          }}
        >
          {m.label}
        </span>
      ))}

      {/* hover point (HTML so it stays a circle) */}
      {hIdx != null && (
        <span style={{ position: "absolute", left: `${hoverX}%`, top: `${py(vals[hIdx])}%`, transform: "translate(-50%, -50%)", width: `${Math.max(4, 0.02 * H)}px`, height: `${Math.max(4, 0.02 * H)}px`, borderRadius: "50%", background: stroke, pointerEvents: "none", zIndex: 1 }} />
      )}

      {/* hover tooltip */}
      {showTooltip && hIdx != null && (
        <div
          style={{
            position: "absolute", left: `${hoverX}%`, top: `${PADT}%`,
            transform: hoverX > 60 ? "translate(-102%, 0)" : "translate(2%, 0)",
            background: "rgba(0,0,0,0.78)", color: stroke, borderRadius: `${0.01 * H}px`,
            padding: `${0.008 * H}px ${0.012 * H}px`, fontSize: `${fontPx}px`, lineHeight: 1.25,
            fontWeight: 600, pointerEvents: "none", whiteSpace: "nowrap", zIndex: 2,
          }}
        >
          <div style={{ opacity: 0.75 }}>{hhmm(history[hIdx].t)}</div>
          <div>{vals[hIdx].toLocaleString()}</div>
          {nearMarker && <div style={{ opacity: 0.85, maxWidth: `${0.35 * H}px`, overflow: "hidden", textOverflow: "ellipsis" }}>{nearMarker.label}</div>}
        </div>
      )}

      {toggle && <GraphToggle mode={toggle.mode} onToggle={toggle.onToggle} stroke={stroke} H={H} />}
    </div>
  );
}

/** Live/recorded toggle for kiosk viewers. Borderless and set in the top-right so
 *  it reads as part of the chart's label layer (the y-axis labels own the left),
 *  rather than a bolted-on button. A green/amber dot carries the state. */
function GraphToggle({ mode, onToggle, stroke, H }: { mode: "live" | "recorded"; onToggle: () => void; stroke: string; H: number }) {
  const [hot, setHot] = useState(false);
  const [down, setDown] = useState(false);
  const dot = `${Math.max(4, 0.016 * H)}px`;
  const pad = `${0.006 * H}px`;
  return (
    <Tooltip label={mode === "live" ? "Showing live — tap for the last recorded service" : "Showing recorded service — tap for live"}>
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        onPointerEnter={() => setHot(true)}
        onPointerLeave={() => { setHot(false); setDown(false); }}
        onPointerDown={() => setDown(true)}
        onPointerUp={() => setDown(false)}
        style={{
          position: "absolute", top: `${0.008 * H}px`, right: `${0.008 * H}px`,
          display: "inline-flex", alignItems: "center", gap: `${0.006 * H}px`,
          // Faint surface only on hover/press — a touch affordance that stays invisible at rest.
          background: down ? "rgba(255,255,255,0.16)" : hot ? "rgba(255,255,255,0.08)" : "transparent",
          color: stroke, border: "none", borderRadius: `${0.02 * H}px`,
          padding: `${pad} ${0.01 * H}px`, margin: `-${pad} -${0.004 * H}px`,
          fontSize: `${Math.max(7, 0.03 * H)}px`, fontWeight: 700, letterSpacing: "0.06em",
          lineHeight: 1, cursor: "pointer", opacity: hot ? 1 : 0.8, zIndex: 3,
          transition: "background 120ms ease, opacity 120ms ease",
        }} aria-label={mode === "live" ? "Showing live — tap for the last recorded service" : "Showing recorded service — tap for live"}>
        <span style={{ width: dot, height: dot, borderRadius: "50%", background: mode === "live" ? "var(--su-live-9)" : "var(--su-warn-9)", flex: "0 0 auto" }} />
        {mode === "live" ? "LIVE" : "REC"}
      </button>
    </Tooltip>
  );
}

// A multi-metric people summary: several building-wide counts side by side (or
// stacked), each value over a small label. All building-level (peak/min/avg are
// not per-zone). avgService = mean peak across recorded services.
const PEOPLE_PANEL_LABELS: Record<string, string> = {
  occupancy: "In room",
  peak: "Peak att.",
  attendance: "Entries (day)",
  serviceAttendance: "Entries (svc)",
  servicePeak: "Peak in room (svc)",
  servicePeakAttendance: "Peak att. (svc)",
  min: "Low",
  avg: "Avg att.",
  avgService: "Avg / service",
  capacity: "Capacity",
  vsAverage: "vs avg",
};
function PeoplePanel({
  config,
  people,
  serviceLow,
  serviceAttendance,
  servicePeak,
  servicePeakAttendance,
  ts,
  H,
}: {
  config: Extract<LayoutObjectConfig, { type: "people-panel" }>;
  people: PeopleCountDTO | null;
  serviceLow: number | null;
  serviceAttendance: number | null;
  servicePeak: number | null;
  servicePeakAttendance: number | null;
  ts: CSSProperties;
  H: number;
}) {
  const metrics: NonNullable<typeof config.metrics> = config.metrics?.length ? config.metrics : ["occupancy", "peak", "attendance"];
  const showLabels = config.showLabels ?? true;
  const col = config.orientation === "column";
  const serviceAvg = useServiceAvgOccupancy(metrics.includes("avgService") || metrics.includes("vsAverage"));
  const t = people?.total;
  const valuePx = parseFloat(String(ts.fontSize)) || 0.12 * H;
  const labelPx = Math.max(8, valuePx * 0.34);
  const {
    wrapRef: fitWrapRef,
    elRef: fitElRef,
    scale: fitScale,
  } = useFitScale<HTMLDivElement>([metrics.join(","), showLabels, col, valuePx, H]);
  // Each tile resolves to a display string + optional color override (vs-average
  // goes green/red). "—" when the underlying value isn't available.
  const tile = (k: string): { text: string; color: string } => {
    const base = String(ts.color ?? "#ffffff");
    if (k === "capacity") {
      const cap = t?.capacity ?? null;
      return { text: cap && t?.occupancy != null ? `${Math.round((t.occupancy / cap) * 100)}%` : "—", color: base };
    }
    if (k === "vsAverage") {
      const peak = t?.peak ?? null;
      if (peak == null || serviceAvg == null) return { text: "—", color: base };
      const d = peak - serviceAvg;
      const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
      return { text: `${sign}${Math.abs(d).toLocaleString()}`, color: d > 0 ? "var(--green-9)" : d < 0 ? "var(--red-9)" : base };
    }
    // "min" = lowest in-room during the live service (the service "floor"), from
    // the attendance record — not the whole-day minimum (which is ~always 0).
    const v =
      k === "avgService" ? serviceAvg
      : k === "min" ? serviceLow
      : k === "serviceAttendance" ? serviceAttendance
      : k === "servicePeak" ? servicePeak
      : k === "servicePeakAttendance" ? servicePeakAttendance
      : ((t as Record<string, number | null> | undefined)?.[k] ?? null);
    return { text: v == null ? "—" : v.toLocaleString(), color: base };
  };
  return (
    // Scaled to fit like every other object: the measured sweep found this one
    // overflowing its box by 386px at a dashboard tile size, because the metrics
    // wrap onto new rows and the wrapped block is simply taller than the tile.
    // Gaps and fonts here are fractions of the CANVAS height, so they do not
    // shrink with the object - scaling the whole block is what makes them.
    <div ref={fitWrapRef} style={{ width: "100%", height: "100%", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
    <div
      ref={fitElRef}
      style={{
        display: "flex",
        flexDirection: col ? "column" : "row",
        flexWrap: "wrap",
        gap: `${0.04 * H}px ${0.06 * H}px`,
        width: "100%",
        height: "100%",
        justifyContent: "space-evenly",
        alignItems: "center",
        transform: `scale(${fitScale})`,
        transformOrigin: "center center",
      }}
    >
      {metrics.map((k) => {
        const { text, color } = tile(k);
        return (
          <div key={k} style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.05 }}>
            <span style={{ color, fontSize: `${valuePx}px`, fontWeight: ts.fontWeight ?? 700 }}>{text}</span>
            {showLabels && (
              <span style={{ color: ts.color, opacity: 0.6, fontSize: `${labelPx}px`, fontWeight: 500, marginTop: `${labelPx * 0.2}px`, whiteSpace: "nowrap" }}>
                {PEOPLE_PANEL_LABELS[k]}
              </span>
            )}
          </div>
        );
      })}
    </div>
    </div>
  );
}

// A baptism-timer readout. `live` shows the running segment clock (ticking off the
// shared 1s `now`); the rest are session stats. Optional sub-label.
function BaptismTimer({
  state,
  config,
  ts,
  now,
}: {
  state: BaptismState | null;
  config: Extract<LayoutObjectConfig, { type: "baptism-timer" }>;
  ts: CSSProperties;
  now: number;
}) {
  const field = config.field ?? "live";
  const sum = summarizeBaptism(state);
  let value = "—";
  let fallback = "";
  if (field === "live") {
    if (state && state.phase !== "idle") {
      // Same calculation as the operator page, so a paused timer on a display shows
      // the held value rather than freezing at whatever it last happened to render.
      value = fmtClock(segmentElapsedMs(state, now));
      if (state.phase === "testimony") fallback = state.mode === "grouped" ? `Testimony ${state.personNumber}` : `Person ${state.personNumber} · testimony`;
      else fallback = state.mode === "grouped" ? `Baptism ${state.baptismIndex + 1}` : `Person ${state.personNumber} · baptism`;
    } else {
      value = "0:00";
      fallback = "ready";
    }
  } else if (field === "count") {
    value = String(sum.count);
    fallback = "baptized";
  } else if (field === "total") {
    value = fmtClock(sum.totalMs);
    fallback = "total time";
  } else if (field === "average") {
    value = sum.count ? fmtClock(sum.avgPersonMs) : "—";
    fallback = "avg per person";
  } else if (field === "last") {
    const last = state?.people[state.people.length - 1];
    value = last ? fmtClock(last.testimonyMs + last.baptizeMs) : "—";
    fallback = "last person";
  }
  // "0:00 avg per person" on a narrow tile is wider than the tile — 49px over in
  // the measured sweep. Same fit-to-box treatment as every other readout.
  const label = config.showLabel ? ` ${config.label ?? fallback}` : "";
  const basePx = parseFloat(String(ts.fontSize)) || 16;
  const { wrapRef, elRef, scale } = useFitScale([value, label, basePx, ts.fontWeight]);
  return (
    <FitBox ts={ts} wrapRef={wrapRef}>
      <span ref={elRef} style={{ ...ts, width: undefined, maxWidth: "100%", fontSize: `${basePx * scale}px`, whiteSpace: "nowrap" }}>
        {value}
        {label ? <span style={{ opacity: 0.6, fontSize: "0.6em" }}>{label}</span> : null}
      </span>
    </FitBox>
  );
}

/** Amber/red once the value crosses the configured dB thresholds, else null (keep base color). */
function splThresholdColor(
  value: number,
  thresholds: { amber: number; red: number } | null | undefined,
): string | null {
  if (!thresholds) return null;
  if (value >= thresholds.red) return "var(--red-10)";
  if (value >= thresholds.amber) return "var(--yellow-10)";
  return null;
}

function batteryColor(pct: number | null): string {
  if (pct === null) return "rgba(255,255,255,0.4)";
  if (pct >= 50) return "var(--green-10)";
  if (pct >= 20) return "var(--yellow-10)";
  return "var(--red-10)";
}

// Shure SBC charger bay battery levels. Renders one row per configured bay with
// only the metrics toggled on; an empty/undocked bay reads "empty".
function ChargerBattery({
  config,
  all,
  H,
  baseStyle,
}: {
  config: Extract<LayoutObjectConfig, { type: "charger-battery" }>;
  all: ChargerBayDTO[];
  H: number;
  baseStyle: CSSProperties;
}) {
  const show = config.show ?? {};
  const anyShown = show.battery || show.charging || show.cycles || show.health || show.temp;
  const showBattery = show.battery || !anyShown; // never render a fully-empty row
  const bays = config.bays ?? [];

  if (bays.length === 0) {
    return <span style={{ ...baseStyle, opacity: 0.35 }}>Charger bays</span>;
  }

  return (
    <div
      className="flex flex-col justify-center w-full h-full min-w-0"
      style={{ ...baseStyle, gap: `${0.012 * H}px` }}
    >
      {bays.map((b) => {
        const bay = all.find((x) => x.id === b.id) ?? null;
        const label = b.label || (bay ? `${bay.connectionName ?? `Charger ${bay.chargerIndex}`} · Bay ${bay.bay}` : "Bay");
        return (
          <div key={b.id} className="flex items-center justify-between gap-[0.5em] w-full min-w-0">
            <span className="truncate min-w-0 flex-1">{label}</span>
            <span className="flex items-center gap-[0.6em] shrink-0 tabular-nums">
              {!bay || !bay.online ? (
                <span style={{ opacity: 0.35 }}>empty</span>
              ) : (
                <>
                  {showBattery && (
                    <span style={{ color: batteryColor(bay.battery), fontWeight: 700 }}>
                      {bay.battery ?? "—"}%
                    </span>
                  )}
                  {show.charging && bay.charging && (
                    <ZapIcon style={{ width: "0.85em", height: "0.85em" }} className="inline-block shrink-0 text-green-10" aria-label="charging" />
                  )}
                  {show.cycles && <span style={{ opacity: 0.7 }}>{bay.cycles ?? "—"} cyc</span>}
                  {show.health && <span style={{ opacity: 0.7 }}>health {bay.health ?? "—"}%</span>}
                  {show.temp && <span style={{ opacity: 0.7 }}>{bay.tempC ?? "—"}°C</span>}
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Plan-attachment object (e.g. the PCO stage plot) ─────────────────────────
// pdf.js is lazy-loaded (code-split) so only displays that actually use a
// plan-attachment object pull it in. Vite resolves the worker via ?url.

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

/** Post-processing applied to the rasterized file (NOT the source PDF). */
export interface AttachmentProcessOpts {
  page: number;
  crop?: { top: number; right: number; bottom: number; left: number } | null;
  trim?: boolean;
  background?: "keep" | "black" | "transparent";
}

const NEAR_WHITE = 244; // r,g,b all above this counts as "page white"

// Rasterize a PDF page (~1600px wide, capped) to a fresh canvas.
async function rasterizePdf(data: ArrayBuffer, pageNum: number): Promise<HTMLCanvasElement> {
  const pdfjs = await loadPdfjs();
  // pdf.js v6: cleanup is via the loading task (PDFDocumentProxy.destroy() was
  // removed); render() now takes the `canvas` itself, not just its 2D context.
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  try {
    const n = clamp(Math.round(pageNum) || 1, 1, doc.numPages);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 1600 / base.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const c2d = canvas.getContext("2d");
    if (!c2d) throw new Error("no 2d context");
    await page.render({ canvas, canvasContext: c2d, viewport }).promise;
    return canvas;
  } finally {
    void loadingTask.destroy();
  }
}

// Draw an image blob to a fresh canvas (~1600px wide, capped).
async function rasterizeImage(buf: ArrayBuffer, contentType: string): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([buf], { type: contentType || "image/*" }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("image decode failed"));
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(1, img.naturalWidth));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function cropCanvas(src: HTMLCanvasElement, crop: { top: number; right: number; bottom: number; left: number }): HTMLCanvasElement {
  const left = clamp(crop.left || 0, 0, 0.95);
  const right = clamp(crop.right || 0, 0, 0.95);
  const top = clamp(crop.top || 0, 0, 0.95);
  const bottom = clamp(crop.bottom || 0, 0, 0.95);
  const x = Math.round(left * src.width);
  const y = Math.round(top * src.height);
  const w = Math.max(1, Math.round((1 - left - right) * src.width));
  const h = Math.max(1, Math.round((1 - top - bottom) * src.height));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")?.drawImage(src, x, y, w, h, 0, 0, w, h);
  return out;
}

// Crop away the near-white border, returning the tight content box.
function trimCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = src.getContext("2d");
  if (!ctx) return src;
  const { width: w, height: h } = src;
  const { data } = ctx.getImageData(0, 0, w, h);
  const isContent = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 16) return false; // transparent
    return !(data[i] > NEAR_WHITE && data[i + 1] > NEAR_WHITE && data[i + 2] > NEAR_WHITE);
  };
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  const rowHas = (y: number) => { for (let x = 0; x < w; x++) if (isContent(x, y)) return true; return false; };
  const colHas = (x: number) => { for (let y = top; y <= bottom; y++) if (isContent(x, y)) return true; return false; };
  while (top < bottom && !rowHas(top)) top++;
  while (bottom > top && !rowHas(bottom)) bottom--;
  while (left < right && !colHas(left)) left++;
  while (right > left && !colHas(right)) right--;
  const cw = right - left + 1;
  const ch = bottom - top + 1;
  if (cw <= 1 || ch <= 1 || (cw === w && ch === h)) return src;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d")?.drawImage(src, left, top, cw, ch, 0, 0, cw, ch);
  return out;
}

// Recolor near-white pixels: fill black or knock out to transparent.
function recolorBackground(src: HTMLCanvasElement, mode: "black" | "transparent"): void {
  const ctx = src.getContext("2d");
  if (!ctx) return;
  const img = ctx.getImageData(0, 0, src.width, src.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > NEAR_WHITE && d[i + 1] > NEAR_WHITE && d[i + 2] > NEAR_WHITE) {
      if (mode === "transparent") {
        d[i + 3] = 0;
      } else {
        d[i] = d[i + 1] = d[i + 2] = 0;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Fetch + rasterize + process a plan attachment into a PNG data URL. Shared by
 * the renderer object and the editor's "Fit box to file" action. Returns the
 * output pixel size so callers can match an object box to the content aspect.
 * Resolves to `"empty"` when nothing matches on the current plan.
 *
 * `cacheBust` (the active plan id) is appended to the URL so a plan change forces
 * a fresh fetch instead of serving the previous plan's file from the 5-min HTTP
 * cache. The server ignores it — it always resolves against the active plan.
 */
export async function loadProcessedAttachment(
  match: string,
  opts: AttachmentProcessOpts,
  cacheBust?: string | null,
): Promise<{ dataUrl: string; width: number; height: number } | "empty" | null> {
  const bust = cacheBust ? `&plan=${encodeURIComponent(cacheBust)}` : "";
  const resp = await fetch(`/api/pco/attachment?match=${encodeURIComponent(match)}${bust}`);
  if (resp.status === 404) return "empty";
  if (!resp.ok) return null;
  const ct = resp.headers.get("content-type") ?? "";
  const buf = await resp.arrayBuffer();
  let canvas = ct.includes("pdf") ? await rasterizePdf(buf, opts.page) : await rasterizeImage(buf, ct);
  if (opts.crop && (opts.crop.top || opts.crop.right || opts.crop.bottom || opts.crop.left)) {
    canvas = cropCanvas(canvas, opts.crop);
  }
  if (opts.trim) canvas = trimCanvas(canvas);
  if (opts.background && opts.background !== "keep") recolorBackground(canvas, opts.background);
  return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}

function PlanAttachment({
  match,
  planId,
  H,
  ...opts
}: AttachmentProcessOpts & { match: string; planId: string | null; H: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");

  // Stable dep for the options object (crop is nested).
  const optsKey = JSON.stringify(opts);

  // Reset to the loading placeholder in the same render the target changes, so a
  // stale image never lingers over the new one.
  useResyncOn([match, optsKey, planId], () => {
    setSrc(null);
    setStatus("loading");
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await loadProcessedAttachment(match, JSON.parse(optsKey) as AttachmentProcessOpts, planId);
        if (cancelled) return;
        if (result === "empty") {
          setStatus("empty");
        } else if (result) {
          setSrc(result.dataUrl);
          setStatus("ready");
        } else {
          setStatus("error");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch when the plan changes — the matched file rolls over week to week.
  }, [match, optsKey, planId]);

  if (status === "ready" && src) {
    return <img src={src} alt="" className="w-full h-full object-contain" draggable={false} />;
  }
  const note =
    status === "loading" ? "Loading…" : status === "empty" ? `No "${match}" on this plan` : "Couldn't load file";
  return (
    <span
      style={{
        fontSize: `${0.022 * H}px`,
        color: "rgba(255,255,255,0.4)",
        textAlign: "center",
        width: "100%",
        padding: `${0.01 * H}px`,
      }}
    >
      {note}
    </span>
  );
}

/**
 * Another View's content, rendered natively inside this layout.
 *
 * The native answer to stacking two browser tabs: the same components the View
 * uses on its own display, sharing this page's React tree and its single SSE
 * connection. An <iframe> would have been a few lines, and would have booted a
 * second copy of the whole app per object — another EventSource, another poll
 * loop — while ignoring the object's style and scaling a full-screen design down
 * instead of reflowing into the box.
 *
 * CUSTOM Views are deliberately not embeddable, and that is the entire recursion
 * guard: a custom View is the only kind that holds a layout, so refusing it means
 * an embed can never reach another embed. No depth counter, nothing to get wrong
 * later. Containers already cover composing objects within one layout.
 *
 * Kinds are added as they stop assuming they own the screen — every View renderer
 * currently hardcodes a viewport height, which is right on a display and wrong in
 * a box. `script` is converted; the rest say so rather than rendering broken.
 */
function ViewEmbedObject({
  o,
  config,
  ctx,
}: {
  o: LayoutObject;
  config: Extract<LayoutObjectConfig, { type: "view-embed" }>;
  ctx: LayoutRenderCtx;
}) {
  const view = config.viewId ? ctx.state.views?.find((v) => v.id === config.viewId) ?? null : null;

  const notice = (text: string) => (
    <div className="flex items-center justify-center h-full text-fg-subtle text-caption1 text-center px-3">{text}</div>
  );

  if (!config.viewId) return notice("Pick a view to embed");
  if (!view) return notice("That view no longer exists");

  if (isEmbeddableViewKind(view.kind)) {
    // w-full h-full, not the object's alignment: boxStyle turns every object into
    // a flex column aligned by textAlign, which shrink-wraps a child that has no
    // width of its own — a left-aligned box rendered the rundown at about half
    // the width it was given. An embed always fills its box; alignment is a text
    // idea and does not apply.
    // The font size is set HERE, on the wrapper, and inherited by the whole
    // rundown. Every other object applies it per text node through textStyle,
    // which an embedded component never passes through — so without this the
    // table fell back to the browser default 16px however large the object was,
    // with no control that did anything.
    return (
      <div className="w-full h-full" style={{ fontSize: `${(o.style?.fontSize ?? EMBED_FONT_FRACTION) * ctx.H}px` }}>
        {/* textSizeClass="" drops the page's viewport-relative clamp so the rows
            inherit the object's own font-size, which boxStyle sets from the
            object's style. Without it the table capped at ~17px however large the
            object was — unreadable on a 4K stage panel, with the font-size field
            hidden as well, so there was no way to fix it. */}
        <ScriptView
          scriptViewLayoutId={view.scriptViewLayoutId ?? null}
          showHeader={config.showHeader ?? false}
          textSizeClass=""
          autoScroll={config.autoScroll ?? true}
        />
      </div>
    );
  }

  return notice(`"${view.name}" is a ${view.kind} view — not embeddable yet`);
}

/** The PCO service order as a scrolling list — highlights the live item and shows
 *  the chosen note categories (e.g. vocal parts) under each item. Reuses the cached
 *  plan-items pipeline (no new PCO request). */
function ServiceOrderObject({
  o,
  config,
  ctx,
}: {
  o: LayoutObject;
  config: Extract<LayoutObjectConfig, { type: "service-order" }>;
  ctx: LayoutRenderCtx;
}) {
  const liveRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const items = ctx.planItems?.items ?? [];
  const currentId = ctx.pcoLive?.currentItemId ?? null;
  const scroll = config.scroll ?? "auto";
  const highlightLive = config.highlightLive ?? true;
  const autoFit = config.autoFit ?? true;

  const H = ctx.H;
  // null/undefined = all present, [] = none, [..] = chosen (and still present).
  const present = ctx.planItems?.noteCategories ?? [];
  const cats =
    config.noteCategories == null ? present : config.noteCategories.filter((k) => present.includes(k));
  // Content signature: re-fit when the item count or shown note categories change.
  const contentKey = `${items.length}:${cats.join(",")}`;

  // Auto-fit: shrink the base font (everything derives from it) so the whole list
  // fits the object's height with no scroll, clamped to a readable minimum. Scale is
  // back-derived from the live scrollHeight so it converges in a pass or two.
  const MIN_FIT = 0.5;
  const [fitScale, setFitScale] = useState(1);
  const fitRef = useLatestRef(fitScale);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      if (!autoFit) {
        if (fitRef.current !== 1) setFitScale(1);
        return;
      }
      const ch = el.clientHeight;
      const sh = el.scrollHeight;
      if (ch <= 0 || sh <= 0) return;
      const cur = fitRef.current;
      const natural = sh / cur; // content height at scale 1
      const desired = clamp(ch / natural, MIN_FIT, 1);
      if (Math.abs(desired - cur) > 0.005) setFitScale(desired);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoFit, contentKey, H, fitScale, fitRef]);

  // Auto-hide scrollbar: only show the thin bar while actively scrolling.
  const [scrolling, setScrolling] = useState(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (scrollTimer.current) clearTimeout(scrollTimer.current); }, []);
  const onScroll = () => {
    setScrolling(true);
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => setScrolling(false), 700);
  };

  useEffect(() => {
    if (scroll === "auto" && liveRef.current) {
      liveRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [currentId, scroll, items.length]);

  const s = o.style ?? {};
  const base = (s.fontSize ?? 0.035) * H * fitScale;
  const color = s.color ?? "#ffffff";

  if (items.length === 0) {
    return <span style={{ ...textStyle(o, H), opacity: 0.4 }}>No service plan</span>;
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={`so-scroll${scrolling ? " scrolling" : ""}`}
      style={{
        width: "100%",
        height: "100%",
        overflowY: scroll === "auto" ? "hidden" : "auto",
        display: "flex",
        flexDirection: "column",
        gap: `${base * 0.12}px`,
        color,
        fontWeight: s.fontWeight ?? 500,
      }}
    >
      {items.map((it, idx) => {
        if (it.itemType === "header") {
          return (
            <div
              key={it.id}
              style={{
                fontSize: `${base * 0.7}px`,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                opacity: 0.5,
                marginTop: `${base * 0.3}px`,
              }}
            >
              {it.title}
            </div>
          );
        }
        const isLive = highlightLive && currentId != null && it.id === currentId;
        // Hairline between consecutive items (not the first, not right under a header).
        const prev = items[idx - 1];
        const divider = idx > 0 && prev && prev.itemType !== "header" && !isLive;
        return (
          <div
            key={it.id}
            ref={isLive ? liveRef : undefined}
            style={{
              borderRadius: `${0.008 * H}px`,
              padding: `${base * 0.1}px ${base * 0.3}px`,
              background: isLive ? "rgba(45,212,150,0.16)" : undefined,
              borderLeft: isLive ? `${0.004 * H}px solid var(--su-live-9)` : `${0.004 * H}px solid transparent`,
              borderTop: divider ? "1px solid rgba(255,255,255,0.07)" : undefined,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: `${base * 0.5}px` }}>
              <span style={{ fontSize: `${base}px`, color: isLive ? "var(--green-11, #4ade80)" : color }}>
                {it.title || "Untitled"}
              </span>
              {config.showLength && it.lengthSec > 0 && (
                <span style={{ fontSize: `${base * 0.75}px`, opacity: 0.55, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {fmtDuration(it.lengthSec)}
                </span>
              )}
            </div>
            {cats.map((k) => {
              const note = it.notesByCategory[k];
              if (!note) return null;
              return (
                <div key={k} style={{ fontSize: `${base * 0.78}px`, opacity: 0.75, marginTop: `${base * 0.05}px`, lineHeight: 1.15 }}>
                  <span style={{ opacity: 0.6 }}>{k}: </span>
                  {note}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Collect the set of object `config.type`s present in a layout (recursing into
 *  container children) so live-data hooks can be gated to only the channels the
 *  layout actually renders. */
function collectLayoutTypes(objects: LayoutObject[] | undefined, into: Set<string>): void {
  for (const o of objects ?? []) {
    if (o.config?.type) into.add(o.config.type);
    if (o.children?.length) collectLayoutTypes(o.children, into);
  }
}

/** Live data + tickers shared by the kiosk renderer and the settings editor.
 *  When a `layout` is passed (kiosk display), the optional/high-frequency data
 *  hooks are gated to the object types the layout contains — so a clock-only
 *  display doesn't subscribe to (or re-render on) SPL/transcript/wireless/etc.
 *  Called with no arg (editor) → every hook is enabled so previews always show data. */
export function useLayoutData(layout?: LayoutDTO) {
  const types = useMemo(() => {
    if (!layout) return null; // editor / unknown → enable everything
    const s = new Set<string>();
    collectLayoutTypes(layout.objects, s);
    return s;
  }, [layout]);
  const want = (kinds: string[]) => types === null || kinds.some((k) => types.has(k));
  const peopleWanted = want(["people-counter", "people-graph", "people-panel"]);

  const { state, isLoading, error, pcoLive, propresenter } = useDashboardState();
  const transcript = useTranscript(want(["transcript-strip"]));
  const spl = useSplState(want(["spl-meter"]));
  const obs = useObsState(want(["obs-status"]));
  const reaper = useReaperState(want(["reaper-status"]));
  const osc = useOscState(want(["osc-button"]));
  const peopleCount = usePeopleCountState(peopleWanted);
  const serviceLow = useLiveServiceLow(peopleWanted);
  const serviceAttendance = useLiveServiceAttendance(peopleWanted);
  const servicePeaks = useLiveServicePeaks(peopleWanted);
  const wireless = useWirelessChannels(want(["wireless-summary", "wireless-channel"]));
  const propInstances = usePropInstances();
  const baptism = useBaptismState();
  const planItems = usePlanItems();
  const serviceTimeline = useServiceTimeline();
  const integrationsSnap = useIntegrations();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [skewMs, setSkewMs] = useState(0);
  useResyncOn([pcoLive?.serverNow], () => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  });

  return { state, isLoading, error, pcoLive, propresenter, propInstances, planItems, transcript, spl, obs, reaper, osc, peopleCount, serviceLow, serviceAttendance, servicePeaks, baptism, serviceTimeline, integrationsSnap, wireless, now, skewMs };
}

/**
 * Renders a custom-layout View: a fixed design canvas scaled to fit the viewport,
 * with absolutely-positioned, live-data-bound objects.
 */
export function LayoutRenderer({
  layout,
  ndiSource,
  interactive = false,
  surface,
}: {
  layout: LayoutDTO;
  ndiSource: string | null;
  interactive?: boolean;
  /** The View's surface, so a console can respond to the window while a display
   *  honours its design. Absent behaves as a display — the safe default. */
  surface?: "display" | "console";
}) {
  const { state, isLoading, error, pcoLive, propresenter, propInstances, planItems, transcript, spl, obs, reaper, osc, peopleCount, serviceLow, serviceAttendance, servicePeaks, baptism, serviceTimeline, integrationsSnap, wireless, now, skewMs } = useLayoutData(layout);

  // Scale the design canvas to fit the container (letterboxed). Callback ref so
  // the observer attaches when the canvas mounts (after the loading guard).
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!box) return;
    const measure = () => {
      const cw = box.clientWidth;
      const ch = box.clientHeight;
      if (cw > 0 && ch > 0) {
        setScale(Math.min(cw / layout.canvas.width, ch / layout.canvas.height));
        setDims({ w: cw, h: ch });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [box, layout.canvas.width, layout.canvas.height]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full kiosk-surface">
        <Loader2Icon className="size-8 text-gray-7 animate-spin" />
      </div>
    );
  }
  if (error || !state) {
    return (
      <div className="flex items-center justify-center h-full kiosk-surface text-gray-7">
        Could not load layout
      </div>
    );
  }

  const { canvas } = layout;
  // "fill": objects (fractional) reflow to fill the whole window — no letterbox.
  // Fonts (fractions of canvas HEIGHT) scale by the live window height so they grow
  // with the window instead of the design canvas.
  // A console responds to the window; a display honours its design exactly. An
  // explicit fit on the layout wins over both.
  const fit = fitFor({ surface } as View, canvas.fit);
  const responsive = fit === "responsive";
  const H = responsive ? dims.h || canvas.height : canvas.height;
  // Placements are computed once per render, from the live viewport. Absent when
  // letterboxed, so that path is untouched.
  const placed = responsive && dims.w && dims.h
    ? new Map(resolveLayout(layout.objects.filter((o) => !o.hidden), canvas, { w: dims.w, h: dims.h }).map((p) => [p.id, p]))
    : undefined;
  // How far the placed objects actually reach. When stacking gives every object
  // the 24px floor - many objects on a tall narrow window - the column is taller
  // than the viewport, and with the container clipped the overflow was simply
  // gone: no scrollbar, no indication, content the operator could not reach.
  const contentBottom = placed
    ? [...placed.values()].reduce((m, o) => Math.max(m, o.top + o.height), 0)
    : 0;
  const overflows = responsive && dims.h > 0 && contentBottom > dims.h + 1;
  // Default/legacy canvas backgrounds inherit the shared kiosk surface so custom
  // layouts match every other view; only an explicit non-default solid overrides.
  const bg = canvas.background;
  const inheritSurface =
    bg == null || bg === "#000" || bg === "#000000" || bg === "#080810" || bg === "#0a0a0a";

  const ctx: LayoutRenderCtx = { state, propresenter, propInstances, pcoLive, planItems, transcript, spl, obs, reaper, osc, peopleCount, serviceLow, serviceAttendance, servicePeak: servicePeaks.occupancy, servicePeakAttendance: servicePeaks.attendance, baptism, serviceTimeline, integrations: integrationsSnap.states, integrationLabels: integrationsSnap.labels, wireless, now, skewMs, ndiSource, H, interactive, placed, canvasBg: inheritSurface ? null : bg };
  const objects = [...layout.objects].filter((o) => !o.hidden).sort((a, b) => a.z - b.z);

  return (
    <div
      ref={setBox}
      className={`relative w-full h-full kiosk-surface flex items-center justify-center ${
        overflows ? "overflow-y-auto overflow-x-hidden" : "overflow-hidden"
      }`}
    >
      <div
        style={
          responsive
            ? {
                position: "absolute",
                inset: 0,
                // Grown to the content when the stacked column is taller than the
                // window, so the container above has something to scroll. Stacking
                // only happens on a responsive surface, which is a control surface
                // - something with a touchscreen, not a wall nobody can scroll.
                ...(overflows ? { bottom: "auto", minHeight: contentBottom } : null),
                background: inheritSurface ? "transparent" : bg,
              }
            : {
                width: canvas.width,
                height: canvas.height,
                background: inheritSurface ? "transparent" : bg,
                transform: `scale(${scale})`,
                transformOrigin: "center center",
                position: "relative",
                flexShrink: 0,
              }
        }
      >
        {objects.map((o) => (
          <RenderObject key={o.id} o={o} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}
