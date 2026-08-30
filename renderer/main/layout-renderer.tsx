import { clamp } from "@main/services/clamp";
import { resolveLayout, type PlacedObject } from "./responsive-layout";
import { HomeCard, isHomeCard } from "../app/home/cards";
import { fitFor } from "./console-fit";
import { useState, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { segmentElapsedMs } from "@main/services/baptism-elapsed";
import { Tooltip } from "../components/ui/tooltip";
import { advancePeakHold, type PeakHold } from "./peak-hold.js";
import { useLatestRef } from "@renderer/lib/use-latest-ref";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { invoke } from "../lib/api";
import { BrandLogo } from "../components/brand-logo";
import { Readout } from "./readout";
import { IDIOM_TYPES } from "@main/types/readout-types";
import { SlotsColumns } from "../components/slots-columns";
import { useDashboardState, usePropInstances } from "./use-dashboard-state";
import { useSplState, resolveSplValue } from "./use-spl-state";
import { useDisplayPresence } from "./use-display-presence";
import { useObsState } from "./use-obs-state";
import { useResiState, useYouTubeState } from "./use-stream-state";
import { streamers, streamIndicator } from "../app/recording-status";
import { usePvpState, usePvpSkewMs } from "./use-pvp-state";
import { useReaperState } from "./use-reaper-state";
import { useScoresState } from "./use-scores-state";
import { ScoresObject } from "./scores-object";
import { useOscState, resolveOscActive } from "./use-osc-state";
import { usePeopleCountState, resolvePeopleValue, useServiceAvgOccupancy, useLiveServiceLow, useLiveServiceAttendance, useLiveServicePeaks } from "./use-people-count-state";
import { useBaptismState, summarizeBaptism, fmtClock } from "./use-baptism-state";
import { useIntegrations } from "./use-integration-states";
import { useWirelessTelemetry } from "./use-wireless-telemetry";
import { OscButton } from "./osc-button";
import { PvpObject } from "./pvp-object";
import { ActionButton } from "./action-button";
import { NotesObject, ChecklistObject } from "./notes-objects";
import { RossTalkButton } from "./rosstalk-button";
import { useTranscript } from "./use-transcript";
import { usePlanItems } from "./use-plan-items";
import { useServiceTimeline } from "./use-service-timeline";
import { computePcoTimer, fmtDuration } from "./pco-timer";
import { EmbeddedView, EmbedFontBox, EmbedNotice } from "./embedded-view";
import { useEmbedBoxHeight } from "./embed-box";
import { childChain, embedRefusal } from "./embed-chain";
import { useExpand } from "./expand-overlay";
import { channelLabel, lineColor } from "./channel-color";
import { TranscriptFeed } from "./transcript-feed";
import { LiveControls } from "./live-controls";
import { Loader2Icon, ZapIcon } from "lucide-react";
import { displayHourCycle, formatClock } from "../lib/clock-format";

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
  /** Live ProVideoPlayer layer state — for the pvp-layers object. null until loaded. */
  pvp: PvpStatusDTO | null;
  /** Clock offset measured from PVP's own frames, not from PCO's. */
  pvpSkewMs: number;
  scores: ScoresStatusDTO | null;
  resi: StreamStatusDTO | null;
  youtube: StreamStatusDTO | null;
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
  H: number;
  /** True only on a real display route. Interactive objects (live controls)
   *  only fire their commands when true — never in the editor or preview iframe. */
  interactive: boolean;
  /** Pixel placements when the layout is rendering responsively; absent when it
   *  is letterboxed, in which case objects position by percentage as before. */
  placed?: Map<string, PlacedObject>;
  /**
   * This is HOME, the operator's own page of tiles — not a console, a wall, or
   * a preview of either.
   *
   * Required rather than optional, so every surface that builds a context has to
   * say which it is. The three streaming cards read it: on Home they are cards
   * like the tiles beside them, and anywhere else they are the wall widget that
   * OBS status and REAPER status are.
   */
  home: boolean;

  /**
   * The views being drawn ABOVE this one, outermost first. Empty at the top.
   *
   * Required rather than optional, exactly like `home` above it and for the same
   * reason: every surface that builds a context has to say which it is. An
   * optional field defaulting to [] would let a surface forget, and a forgotten
   * chain reads as "nothing above me" — which is the one answer that makes a
   * cycle undetectable.
   */
  embedChain: readonly string[];

  /**
   * Screens with a browser actually attached, from the `displays:presence`
   * heartbeat — not screens that merely have a view routed.
   *
   * Required, like `embedChain` and `home`, so a surface cannot quietly report
   * an empty set. Empty is a legitimate answer (nothing is on); "I forgot to
   * pass it" must not be indistinguishable from it.
   */
  onlineOutputIds: readonly string[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Box-level CSS (position handled by caller): background, border, radius, and
 * flex alignment derived from text/vertical alignment.
 *
 * NOT padding or opacity, which this doc claimed until 1.11 and which the
 * function has not set for some time. The cull was deliberate — the readouts
 * size themselves from their box now, so a hand-typed pad fights the thing that
 * replaced it — but an object saved with either still carries the value, and it
 * simply does nothing. Said plainly here rather than left as a doc describing
 * code that is not there.
 */
export function boxStyle(o: LayoutObject, H: number): CSSProperties {
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
  // The object's own text colour, published for the readout idiom to pick up.
  // A readout sets its value colour EXPLICITLY (an inherited one resolved to
  // black-on-black on the kiosk surface once, measured at 1.06:1), so a colour
  // chosen in the inspector never reached it — every readout ignored the Color
  // control entirely. A custom property is read by the one place that wants it
  // and inherited by nothing that does not.
  if (s.color) (css as Record<string, unknown>)["--readout-value-color"] = s.color;
  // And the vertical alignment, for the same reason: the readout idiom paints
  // over this box absolutely, so the justifyContent above governs only the
  // objects that do NOT use it. Every readout ignored the pad's top and bottom
  // rows entirely — three of the nine cells did anything at all.
  if (s.vAlign) {
    (css as Record<string, unknown>)["--readout-v-align"] =
      s.vAlign === "top" ? "flex-start" : s.vAlign === "bottom" ? "flex-end" : "center";
  }
  if (s.cornerRadius != null) css.borderRadius = `${s.cornerRadius * H}px`;
  // Clamp so a stray/legacy width can't swell into a solid fill.
  if (s.borderColor && s.borderWidth) css.border = `${Math.min(s.borderWidth, 0.04) * H}px solid ${s.borderColor}`;
  if (o.config.type === "shape" && o.config.shape === "ellipse") css.borderRadius = "50%";
  return css;
}

/**
 * Readouts whose content is a NUMBER that changes while you watch it.
 *
 * These get tabular figures in the mono face. Proportional digits are different
 * widths, so a clock reflows every second and an SPL meter jitters ten times a
 * second — the text physically moves, which is the one thing a readout on a wall
 * must not do. Tabular digits all occupy the same width, so only the glyphs
 * change.
 *
 * Decided per type here rather than offered as a switch: there is no version of
 * "my clock should wobble" worth building a control for. Types whose content is
 * words (status pills, wireless summaries) are deliberately absent — mono makes
 * prose worse.
 */
const TABULAR_TYPES = new Set<string>([
  "clock", "countdown-timer", "pp-timer", "baptism-timer",
  "spl-meter", "people-counter", "service-pacing", "slide-progress", "charger-battery",
]);

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
  if (TABULAR_TYPES.has(o.config.type)) {
    css.fontFamily = "var(--font-mono)";
    css.fontVariantNumeric = "tabular-nums";
  }
  if (s.italic) css.fontStyle = "italic";
  if (s.uppercase) css.textTransform = "uppercase";
  if (s.letterSpacing != null) css.letterSpacing = `${s.letterSpacing}em`;
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

/**
 * A placed rect as CSS, relative to the box it is drawn inside.
 *
 * resolveLayout returns VIEWPORT-ABSOLUTE pixels -- responsive-layout.ts computes
 * `left = box.left + o.x * box.w`, and its own test asserts a child of a
 * container at 960 comes back as 960. But RenderObject draws children inside the
 * parent's own `position:absolute` div, so applying those pixels there added the
 * parent's offset a second time. With `overflow:hidden` on the parent, a nested
 * object did not merely shift -- it disappeared.
 *
 * fitFor returns "responsive" by DEFAULT for every console surface, so this hit
 * the release's new console pages, panels and the editor preview: every layout
 * with a container in it.
 *
 * Subtracting the origin here rather than changing resolveLayout keeps that
 * module's contract -- and its tests -- intact: absolute is the right answer for
 * a layout engine that has to reason about anchors and stacking across the whole
 * canvas. Only the drawing is relative.
 */
export function placedGeometry(
  placed: { left: number; top: number; width: number; height: number },
  origin: { left: number; top: number } | null,
): { left: string; top: string; width: string; height: string } {
  return {
    left: `${placed.left - (origin?.left ?? 0)}px`,
    top: `${placed.top - (origin?.top ?? 0)}px`,
    width: `${placed.width}px`,
    height: `${placed.height}px`,
  };
}

/** Render one object (and, for containers, its children) as a positioned box.
 *  Position/size are PERCENT of the parent — because the wrapper is absolutely
 *  positioned, a child's % resolves against this box, so the same component
 *  renders correctly at any nesting depth. Font/radius/padding stay canvas-
 *  relative (boxStyle uses ctx.H = canvas height) regardless of depth. */
export function RenderObject({
  o,
  ctx,
  origin,
}: {
  o: LayoutObject;
  ctx: LayoutRenderCtx;
  /** The placed rect of the box this is drawn inside, when there is one. */
  origin?: { left: number; top: number } | null;
}) {
  const kids = o.children?.length
    ? [...o.children].filter((c) => !c.hidden).sort((a, b) => a.z - b.z)
    : null;
  // Responsive layouts are placed in absolute pixels by resolveLayout, which is
  // where anchors, aspect, clamps and stacking are decided. Everything else keeps
  // the percentage positioning it has always used — that is what makes the
  // default a no-op rather than a re-implementation of it.
  const placed = ctx.placed?.get(o.id);
  const geometry = placed
    ? placedGeometry(placed, origin ?? null)
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
        ...boxStyle(o, ctx.H),
      }}
    >
      {kids
        ? // Children are drawn INSIDE this box, so they measure from its origin.
          kids.map((c) => <RenderObject key={c.id} o={c} ctx={ctx} origin={placed ?? origin} />)
        : <ObjectContent o={o} ctx={ctx} />}
    </div>
  );
}

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

// The status DOT is gone, with StatusDot and DOT_IDLE.
//
// It was a coloured circle beside a name: it said what the widget was watching
// but never what it found, so reading it meant knowing the colour code. The
// replacement says more, not less — the state is spelled out as a word AND
// carries the colour, so "PCO / ONLINE" in green reads at a glance and still
// reads without the green.

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


/**
 * A caption above a readout — "SERVICE STARTS IN" over a countdown.
 *
 * A bare 0:04:12 on a wall does not say what it is counting to, and the operator
 * who built the layout is not the one reading it on Sunday morning. The caption
 * is set on NEW objects by the registry and absent on ones that already exist,
 * so nobody's layout grows a caption it did not ask for.
 *
 * Sized and dimmed against the value rather than set in pixels, so it stays in
 * proportion at a dashboard tile and on a wall alike — the value keeps its own
 * auto-fit, and the caption simply rides above it.
 */
function Captioned({ caption, ts, children }: { caption?: string | null; ts: CSSProperties; children: ReactNode }) {
  if (!caption) return <>{children}</>;
  const align = ts.textAlign === "left" ? "flex-start" : ts.textAlign === "right" ? "flex-end" : "center";
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: align, overflow: "hidden", minHeight: 0 }}>
      <span
        style={{
          color: ts.color,
          // 0.32em at 55% was unreadable at a dashboard tile — reported off a
          // real screen. A caption has to be legible or it is decoration.
          opacity: 0.75,
          fontSize: "0.46em",
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          lineHeight: 1.2,
          // Its own font, not the value's: a caption is words, and the mono face
          // a numeric readout uses makes words worse.
          fontFamily: "inherit",
          flexShrink: 0,
        }}
      >
        {caption}
      </span>
      <span style={{ minHeight: 0, flex: "1 1 auto", width: "100%", display: "flex", flexDirection: "column", justifyContent: "center" }}>{children}</span>
    </div>
  );
}

/** Seconds until the next service, or null. Same source as the context bar. */
function homeSecondsToStart(ctx: LayoutRenderCtx): number | null {
  const t = computePcoTimer(ctx.pcoLive, ctx.now, ctx.skewMs);
  return t && !t.over ? t.seconds : null;
}

/**
 * One object's content, plus its caption if it has one.
 *
 * The caption is applied HERE rather than in each readout's case, so it is a
 * property of the object instead of six near-identical edits inside a switch —
 * and so a type that grows one later gets it without touching the renderer. Both
 * call sites (the display renderer and the editor canvas) come through here, so
 * the editor shows exactly what the wall will.
 */
export function ObjectContent({ o, ctx }: { o: LayoutObject; ctx: LayoutRenderCtx }) {
  const caption = (o.config as { caption?: string | null }).caption;
  if (!caption || IDIOM_TYPES.has(o.config.type)) return <ObjectBody o={o} ctx={ctx} />;
  return (
    <Captioned caption={caption} ts={textStyle(o, ctx.H)}>
      <ObjectBody o={o} ctx={ctx} />
    </Captioned>
  );
}

/**
 * Home cards that have a WALL twin, and which platform each asks about.
 *
 * These three are listed in the palette as "Resi status" and "YouTube status"
 * under their own groups, so they are what an operator picks for a console as
 * well as for Home — and on a console they sit beside OBS status and REAPER
 * status, which are wall widgets. Same object, two presentations, chosen by the
 * surface rather than by which of two near-identical types got picked.
 *
 * `null` means "every platform at once", which is what the caption "Streaming"
 * says. An explicit record rather than a prefix test: the prefix would also
 * catch a future home-streaming-* card that has no wall twin.
 */
/**
 * Whether a status widget paints its whole box while the thing it watches is
 * ACTIVE — recording, or live.
 *
 * One constant for all three because the bug it fixes was the two defaults
 * disagreeing: `fillWhenRecording` was `?? true` and `fillWhenLive` was
 * `?? false`, so OBS and REAPER were bold slabs on a wall and Resi and YouTube
 * were quiet grey text beside them. Written out at each site, the pair drifted
 * apart and stayed apart across two attempts to make these widgets match.
 *
 * A layout that has explicitly turned one off keeps it off — this is only what
 * an object that never expressed a preference does.
 */
export const FILL_WHEN_ACTIVE = true;

/**
 * What a status widget shows when the operator has typed nothing of their own.
 *
 * Exported because the inspector has to promise what the renderer delivers. Its
 * placeholders read "REAPER: Recording" and "OBS: Offline" while the renderer
 * drew a bare "Recording" and "Offline" — the caption already says which box it
 * is, so the prefix came out. An operator who left the field alone got something
 * other than the greyed-out text the field showed them, in four places.
 *
 * OBS's active and idle words are not here: they depend on whether it is
 * recording, streaming or running a virtual cam, so the inspector has no single
 * value to promise and its placeholders stay generic.
 */
export const STATUS_TEXT = {
  reaper: { recording: "Recording", idle: "Standby", offline: "Offline" },
  obs: {
    offline: "Offline",
    // Per mode, because OBS's widget reflects whichever output the operator
    // picked. Keyed by the same `mode` value both files already compute, so the
    // inspector can promise the exact string the renderer will draw — the first
    // pass at this left these two behind on the theory that mode-dependence made
    // them unpromisable, which was wrong, and the two copies had already drifted
    // on capitalisation ("Virtual cam" against "Virtual Cam").
    recording: { active: "Recording", idle: "Standby" },
    streaming: { active: "Streaming", idle: "Stream off" },
    virtualcam: { active: "Virtual cam", idle: "Cam off" },
  },
} as const;

/** The OBS mode words, falling back to recording for an unknown stored value. */
export function obsModeText(mode: string): { active: string; idle: string } {
  return mode === "streaming" ? STATUS_TEXT.obs.streaming
    : mode === "virtualcam" ? STATUS_TEXT.obs.virtualcam
    : STATUS_TEXT.obs.recording;
}

const WALL_TWIN = {
  "home-streaming": null,
  "home-streaming-resi": "Resi",
  "home-streaming-youtube": "YouTube",
} as const;

function ObjectBody({ o, ctx }: { o: LayoutObject; ctx: LayoutRenderCtx }) {
  const c = o.config;
  const ts = textStyle(o, ctx.H);
  // Every readout fits its box. This helper backs the plain-text objects
  // (text, slide text, slide notes), and routing it through FitText is what
  // makes a per-object font size unnecessary rather than merely unfashionable.
  const span = (text: string) => <FitText text={text} ts={ts} vAlign={o.style?.vAlign} />;
  // The idiom: caption, value, sub — sized from the box. Every readout that has
  // moved goes through here, so the composition has exactly one implementation
  // and its caption comes from the object rather than from six edits in a switch.
  const readout = (
    value: ReactNode,
    opts?: {
      sub?: string | null;
      valueColor?: string | null;
      fill?: string | null;
      /** Overrides the object's own caption — for a widget whose caption names
       *  the source rather than being typed by the operator. */
      caption?: string | null;
      upper?: boolean;
      dim?: boolean;
    },
  ) => (
    <Readout
      caption={(c as { caption?: string | null }).caption}
      value={value}
      mono={TABULAR_TYPES.has(c.type)}
      // The object's own alignment, so a custom view can centre one widget
      // without every other readout following it.
      align={o.style?.textAlign}
      // Home is a grid of same-height tiles, so its values share a size rather
      // than each one filling whatever its own lines leave.
      uniform={ctx.home}
      {...opts}
    />
  );

  /**
   * The WALL composition for a streaming widget: caption, the state as a word,
   * and the ticking number underneath.
   *
   * Deliberately the same one obs-status and reaper-status use. They answer the
   * same kind of question on the same wall, and reading differently made the
   * streaming ones look like a different app — a duration where its neighbour
   * had a word.
   *
   * A function because TWO things need it: the `stream-status` object, and the
   * three home-streaming cards when they are placed on something that is not
   * Home. Those went to Home's card composition on every surface for a release,
   * which put a small three-line mono tile in a row of large ALL-CAPS ones.
   */
  /**
   * A recorder's state as a readout: OBS, REAPER, and the generic recorder.
   *
   * The three of them ended in the same pair of Readouts -- active with the red
   * fill-or-text rule, idle dimmed when nothing is reachable -- differing only in
   * caption, words and sub-line. FILL_WHEN_ACTIVE was added this release to stop
   * the fill DEFAULT drifting, but the expression consuming it was still written
   * out three times, which is the same drift one level up.
   *
   * Red, not green: red is what a recorder means by "rolling", and a wall
   * carrying recorders and streams wants exactly one red. streamingReadout stays
   * separate for that reason -- its value and sub-line come from streamIndicator,
   * so folding the two together would mean a colour parameter and a second value
   * path for one caller.
   */
  const statusReadout = (s: {
    caption: string;
    active: boolean;
    connected: boolean;
    filled: boolean;
    activeText: string;
    idleText: string;
    offlineText: string;
    sub?: string | null;
  }) => (
    <Readout
      caption={s.caption}
      value={s.active ? s.activeText : s.connected ? s.idleText : s.offlineText}
      sub={s.active ? (s.sub ?? null) : null}
      upper
      fill={s.active && s.filled ? "var(--red-9)" : null}
      valueColor={s.active && !s.filled ? "var(--red-10)" : null}
      // Dim only when nothing is reachable, so a neutral value is never mistaken
      // for "not recording" when the recorder simply cannot be reached.
      dim={!s.active && !s.connected}
      align={o.style?.textAlign}
    />
  );

  const streamingReadout = (
    only: string | null,
    opts: { showElapsed?: boolean; hideWhenIdle?: boolean; fillWhenLive?: boolean },
  ) => {
    const all = streamers(ctx.resi, ctx.youtube, ctx.obs);
    const chosen = only ? all.filter((x) => x.name === only) : all;
    const ind = streamIndicator(chosen, ctx.now, { showElapsed: opts.showElapsed });
    const live = ind.state === "live";
    // Tally-light mode: nothing on screen unless something is going out.
    if (!live && (opts.hideWhenIdle ?? false)) return null;

    // FILLED BY DEFAULT, the same as obs-status and reaper-status.
    //
    // This is the whole of why the streaming widgets did not match the recorders
    // on a wall. Every other choice was already shared — same composition, same
    // caption, same word-then-number — but `fillWhenRecording` defaulted ON and
    // `fillWhenLive` defaulted OFF, so a row of four read as two bold slabs and
    // two lines of quiet text, and the two that mattered most were the quiet
    // ones. Set them the same and the four are indistinguishable in weight; only
    // the colour differs, which is the distinction that was meant to be visible.
    const filled = opts.fillWhenLive ?? FILL_WHEN_ACTIVE;

    // GREEN for live, grey for anything else. Not the red a recorder uses: red
    // is what OBS and REAPER mean by "rolling", and a wall carrying both wants
    // one red.
    return readout(ind.value, {
      caption: only ?? "Streaming",
      // Only where there is a number to put underneath. On a wall the quiet
      // states are one word; Home shows the connection line instead.
      sub: ind.state === "live" ? ind.sub : null,
      upper: true,
      // QUIET IS ONE THING. Off air and unreachable both read at the same
      // strength, because both mean "nothing is going out" and the WORD already
      // says which.
      //
      // Off air used to be `--color-fg-muted`, a third level at 70% between a
      // dimmed 45% and full white. On a wall beside REAPER and OBS -- which dim
      // when they cannot be reached -- it was the brightest quiet thing in the
      // row and read as the one still doing something. Reported twice as the
      // streaming widgets not matching the grey their neighbours wear.
      dim: !live,
      fill: live && filled ? "var(--green-9)" : null,
      valueColor: live && !filled ? "var(--green-10)" : null,
    });
  };

  // Home's cards, BEFORE the switch. They render the SAME components Home's
  // fixed panel does, so the editable Home and the built-in one cannot drift
  // into looking like two different products — and asking first is what keeps
  // that true. As cases they sat below `stream-status`, which listed the three
  // streaming home types alongside itself and drew them with the wall's
  // composition: two ALL-CAPS lines in a row of three-line cards. isHomeCard is
  // exhaustive by type, so no case can shadow one of these again.
  //
  // Clicks reach these cards on HOME and nowhere else.
  //
  // Some of them contain in-app links (/screens, /history) put there for Home,
  // which runs in the operator shell. Every OTHER surface that renders them — a
  // wall display, a panel — is on the kiosk router, whose whole route table is
  // "/". A touch on the SPL stat took a display to a "Route not found" page and
  // left it there until somebody walked over and reloaded it.
  //
  // This used to be pointer-events-none ALWAYS, on the reasoning that "Home
  // renders them directly, not through here". That stopped being true when Home
  // became a grid: HomeGrid draws every card through ObjectContent, so the
  // blanket rule made the operator's own front page inert. Its readiness card's
  // chevrons went nowhere, its drill-downs did nothing, and its checklist could
  // not be ticked — reported as "I am not able to interact with the widget at
  // all", which was exactly right and was true of every card on the page.
  //
  // `home` alone is not enough: the layout EDITOR sets home:true when the Home
  // view is open, and a link that navigates out of the editor mid-edit is the
  // same bug wearing different clothes. `interactive` is false there and on
  // every wall surface, so the pair is the honest test — this is the operator's
  // own screen, and it is live.
  if (isHomeCard(c)) {
    // OFF HOME, the three streaming cards wear the wall composition instead.
    //
    // They are the only home types with a wall twin — the palette lists them as
    // "Resi status" and "YouTube status" under their own groups, which is what
    // an operator picks for a console, where they sit beside OBS status and
    // REAPER status. One object, two presentations, chosen by the surface it is
    // drawn on rather than by which of two near-identical types got picked.
    const platform = WALL_TWIN[c.type as keyof typeof WALL_TWIN];
    if (!ctx.home && platform !== undefined) return streamingReadout(platform, {});
    const live = ctx.home && ctx.interactive;
    return (
      <div className={live ? "w-full h-full" : "w-full h-full pointer-events-none"}>
        <HomeCard
          type={c.type}
          state={ctx.state}
          pcoLive={ctx.pcoLive}
          now={ctx.now}
          skewMs={ctx.skewMs}
          onlineOutputIds={ctx.onlineOutputIds}
          secondsToStart={homeSecondsToStart(ctx)}
        />
      </div>
    );
  }

  switch (c.type) {
    case "text":
      return span(c.text);
    case "clock":
      // The idiom, not FitText. The old path grew one string until it ran out of
      // room, which made the size an accident of the box: "2:26:41 PM" is 4px
      // wider than a 257px tile, so the same clock was huge on a wall and
      // microscopic in a column. Readout sizes it from the height and shrinks it
      // only when the width genuinely cannot take it.
      // `format` unset means the object never expressed a preference, so it
      // follows the app-wide setting. An object that DID set one keeps it — a
      // clock deliberately put on a wall in 24h must not flip because someone
      // changed a preference for the operator app.
      return readout(clockText(ctx.now, c.showSeconds ?? true, c.format ?? displayHourCycle(), c.showMeridiem ?? true));
    case "countdown-timer": {
      const t = computePcoTimer(ctx.pcoLive, ctx.now, ctx.skewMs);
      if (!t) return (c.hideWhenIdle ?? false) ? null : readout("—");
      // Red once the timer goes negative (item or service ran over), like the
      // dashboard; amber once it drops to/below the configured warning; else keep
      // the idiom's own value colour.
      const warning = c.warnSeconds != null && !t.over && t.seconds <= c.warnSeconds;
      const color = t.over ? "var(--red-10)" : warning ? "var(--yellow-10)" : null;
      return readout(fmtDuration(t.seconds), { valueColor: color });
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
      if (deltaSec == null) return (c.hideWhenIdle ?? false) ? null : readout("—");
      const behind = deltaSec > tol;
      const ahead = deltaSec < -tol;
      const color = behind ? c.behindColor ?? "var(--red-10)" : ahead ? c.aheadColor ?? "var(--green-10)" : null;
      const text = !behind && !ahead ? "0:00" : fmtSignedDuration(deltaSec);
      // "behind" / "ahead" moves to the sub-line. It was an inline 0.6em span
      // riding on the number, which is the composition the idiom replaces: a
      // qualifier belongs under the value, not welded to the end of it.
      return readout(text, {
        valueColor: color,
        sub: (c.showLabel ?? false) && (behind || ahead) ? (behind ? "behind" : "ahead") : null,
      });
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
    case "screen-embed":
      return <ScreenEmbedObject o={o} config={c} ctx={ctx} />;
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
      // The section's own colour becomes the FILLED variant's ground rather than
      // a pill floating inside the box. Same caption/value/sub composition,
      // painted on a solid ground — a filled widget is the same widget wearing a
      // state, not a second design language.
      return readout(sec.name, { fill: sec.colorHex });
    }
    case "pp-timer": {
      const pro = c.propresenterInstanceId ? ctx.propInstances?.status[c.propresenterInstanceId] : ctx.propresenter;
      const timers = pro?.timers ?? [];
      const timer = c.timerName ? timers.find((t) => t.name === c.timerName) : timers[0];
      if (!timer) return (c.hideWhenIdle ?? false) ? null : readout("—");
      // Color only on clearly-expired states; unknown/other states stay neutral.
      const state = (timer.state ?? "").toLowerCase();
      const danger = state.includes("over") || state.includes("expire");
      const color = (c.warnStates ?? true) && danger ? "var(--red-10)" : null;
      // The timer's NAME goes on the sub-line. It was an inline 0.6em span in
      // front of the time — so a timer called "Sermon" pushed the number off
      // centre and shrank with it. Under the value it stays a label.
      return readout(timer.time, {
        valueColor: color,
        sub: (c.showLabel ?? true) ? timer.name : null,
      });
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
      return readout(text, { sub: (c.showLabel ?? false) && !dim ? "slides" : null });
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
      // Resolved BY OBJECT wherever the server could do it -- inline grids, and
      // grids embedding a view. Both are free-dragged boxes on a custom layout,
      // so both get photos cropped for an unknown shape (see AvatarFit); keying
      // on the object is what lets them differ from the source view's own
      // display, which keeps the column crop it is correctly modelled on.
      //
      // slotsByView is the fallback, and it still matters: a state broadcast from
      // a server that has not resolved this object yet, or an object whose id is
      // not in the layout the server holds, would otherwise draw an empty grid.
      const inline = c.source === "inline";
      const byObject = ctx.state.slotsByLayoutObject?.[o.id];
      const slots = inline
        ? (byObject ?? [])
        : (byObject ?? (c.sourceViewId ? (ctx.state.slotsByView?.[c.sourceViewId] ?? []) : []));
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
      return <SplMeterValue config={c} spl={ctx.spl} align={o.style?.textAlign} />;
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
      if (value == null) return readout("—");
      const fallbackLabel =
        metric === "occupancy" ? "in room" : metric === "peak" ? "peak att." : metric === "min" ? "low" : metric === "avg" ? "avg att." : metric === "serviceAttendance" ? "svc entries" : metric === "servicePeak" ? "svc peak" : metric === "servicePeakAttendance" ? "svc peak att." : "entries";
      return readout(value.toLocaleString(), {
        sub: c.showLabel ? c.label ?? fallbackLabel : null,
      });
    }
    case "people-graph":
      return <PeopleGraphObject ctx={ctx} config={c} ts={ts} />;
    case "people-panel":
      return <PeoplePanel config={c} people={ctx.peopleCount} serviceLow={ctx.serviceLow} serviceAttendance={ctx.serviceAttendance} servicePeak={ctx.servicePeak} servicePeakAttendance={ctx.servicePeakAttendance} ts={ts} H={ctx.H} />;
    case "baptism-timer":
      return <BaptismTimer state={ctx.baptism} config={c} now={ctx.now} align={o.style?.textAlign} />;
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

      // Which recorder this is watching becomes the caption; the state becomes
      // the value. "any" has no single source to name, so it says what it is.
      const caption = src === "obs" ? "OBS" : src === "reaper" ? "REAPER" : "Recorder";
      // The fill stays -- it is a see-it-across-the-room signal and it works.
      // What changed is that it carries the same composition as every other
      // widget, so a filled widget is the same widget wearing a state rather
      // than a second design language.
      return statusReadout({
        caption,
        active,
        connected,
        filled: c.fillWhenRecording ?? FILL_WHEN_ACTIVE,
        activeText: c.recordingText ?? "RECORDING",
        idleText: c.idleText ?? "STANDBY",
        offlineText: c.offlineText ?? "NO RECORDER",
      });
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
      // Per-mode default labels (overridable via the *Text fields). BARE now —
      // "OBS" is the caption, so the old "OBS: Recording" would have read
      // "OBS / OBS: RECORDING". A label an operator typed themselves is left
      // exactly as they typed it.
      const { active: activeDefault, idle: idleDefault } = obsModeText(mode);
      // Timecode is the record duration -- only meaningful in recording mode. It
      // is the SUB-LINE: welded onto the end of the label it made the string long
      // enough to shrink the state word it was qualifying.
      return statusReadout({
        caption: "OBS",
        active,
        connected,
        filled: c.fillWhenRecording ?? FILL_WHEN_ACTIVE,
        activeText: c.recordingText ?? activeDefault,
        idleText: c.idleText ?? idleDefault,
        offlineText: c.offlineText ?? STATUS_TEXT.obs.offline,
        sub: mode === "recording" && c.showTimecode ? (obs?.recordTimecode ?? null) : null,
      });
    }
    case "stream-status":
      return streamingReadout(
        c.platform && c.platform !== "any" ? (c.platform === "resi" ? "Resi" : "YouTube") : null,
        { showElapsed: c.showElapsed, hideWhenIdle: c.hideWhenIdle, fillWhenLive: c.fillWhenLive },
      );

    case "reaper-status": {
      const reaper = ctx.reaper;
      const connected = reaper?.connected ?? false;
      const recording = reaper?.recording ?? false;
      // Pure tally-light mode: nothing on screen unless REAPER is recording.
      if (!recording && (c.hideWhenIdle ?? false)) return null;
      // Position ticks while recording -- trim REAPER's ".mmm" to whole seconds.
      // It is the sub-line, matching OBS's timecode: the two recorders say the
      // same kind of thing and should say it in the same place.
      const posRaw = reaper?.positionString ?? "";
      const dot = posRaw.indexOf(".");
      const pos = c.showPosition && posRaw ? (dot === -1 ? posRaw : posRaw.slice(0, dot)) : null;
      return statusReadout({
        caption: "REAPER",
        active: recording,
        connected,
        filled: c.fillWhenRecording ?? FILL_WHEN_ACTIVE,
        activeText: c.recordingText ?? STATUS_TEXT.reaper.recording,
        idleText: c.idleText ?? STATUS_TEXT.reaper.idle,
        offlineText: c.offlineText ?? STATUS_TEXT.reaper.offline,
        sub: pos,
      });
    }
    case "pvp-layers":
      return <PvpObject config={c} status={ctx.pvp} now={ctx.now} skewMs={ctx.pvpSkewMs} />;

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
      const color =
        conn === "connected" ? "var(--green-10)"
        : conn === "error" ? "var(--red-10)"
        : conn === "connecting" ? "var(--yellow-10)"
        : null;
      const name = c.label ?? (st ? (ctx.integrationLabels[st.id] ?? st.id) : "—");
      // WHICH integration is the caption; whether it is up is the value. The old
      // shape was a coloured dot beside a name, which said what it was watching
      // but never what it found — you had to know the colour code to read it.
      const word =
        conn === "connected" ? "Online"
        : conn === "error" ? "Error"
        : conn === "connecting" ? "Connecting"
        : "Offline";
      return (
        <Readout
          caption={(c.showLabel ?? true) ? name : null}
          value={word}
          upper
          valueColor={color}
          dim={conn === "disconnected"}
            align={o.style?.textAlign}
        />
      );
    }
    case "wireless-summary": {
      const ch = ctx.wireless;
      if (ch.length === 0) return <Readout value="—" dim />;
      const online = ch.filter((d) => d.online).length;
      const live = ch.filter((d) => d.online);
      const batteries = live.filter((d) => d.battery != null).map((d) => d.battery as number);
      const lowest = batteries.length ? Math.min(...batteries) : null;
      // The pack that runs out FIRST is the one that decides whether anybody has
      // to move mid-service, so the fleet figure is the minimum, exactly as the
      // battery figure is.
      const runtimes = live.filter((d) => d.batteryMinutes != null).map((d) => d.batteryMinutes as number);
      const soonest = runtimes.length ? Math.min(...runtimes) : null;
      const showOnline = c.showOnline ?? true;
      const showBattery = c.showBattery ?? true;
      const showRuntime = c.showRuntime ?? false;
      // The count is the value; the lowest battery is what qualifies it. They
      // were two figures side by side in different colours, which reads as two
      // separate readouts sharing a box.
      const quals = [
        showBattery && lowest != null ? `${lowest}% lowest` : null,
        showRuntime && soonest != null ? `${runtimeText(soonest)} left` : null,
      ].filter(Boolean);
      // With the count off, the tile is a single figure — battery if it is on,
      // otherwise runtime, so turning battery off does not leave a blank tile.
      //
      // ONE flag for the figure and its colour. The condition was written out
      // twice, once for each, and two copies of "which figure is this" is how a
      // tile ends up showing minutes coloured by battery thresholds.
      const batteryLeads = showBattery || !showRuntime;
      const headline = batteryLeads ? `${lowest ?? "—"}%` : (runtimeText(soonest) ?? "—");
      return (
        <Readout
          caption={(c.showLabel ?? false) && c.label ? c.label : null}
          value={showOnline ? `${online}/${ch.length}` : headline}
          sub={showOnline ? quals.join("  ") || null : quals.slice(1).join("  ") || null}
          valueColor={showOnline ? null : batteryLeads ? batteryColor(lowest) : runtimeColor(soonest)}
          mono
            align={o.style?.textAlign}
        />
      );
    }
    case "wireless-channel": {
      const d = c.channelId ? ctx.wireless.find((x) => x.channelId === c.channelId) : ctx.wireless[0];
      if (!d) return <Readout value="—" dim />;
      const show = c.show ?? { rf: true, battery: true, frequency: true };
      // The channel already had this composition — a small dim name over a row of
      // figures — hand-rolled at 0.55em. It is the idiom, so it uses the idiom:
      // the mic's name is the caption, its battery the value it is checked for,
      // and RF and frequency the qualifiers under it.
      const battery = show.battery && d.battery != null ? `${d.battery}%` : null;
      const runtime = show.runtime ? runtimeText(d.batteryMinutes) : null;
      // Percentage wins the headline when both are on, because it is the figure
      // that has always been there and a wall people have learned should not
      // rearrange itself. With percentage OFF, runtime takes the headline — which
      // is what asking for "time remaining instead" means.
      const headline = battery ?? runtime;
      const quals = [
        // The one that did not get the headline still gets said.
        battery && runtime ? runtime : null,
        show.rf && d.rfBars != null ? rfBarsGlyph(d.rfBars) : null,
        show.frequency && d.frequencyLabel ? d.frequencyLabel : null,
        show.audio && d.audioLevel != null ? `${Math.round(d.audioLevel * 100)}%` : null,
      ].filter(Boolean);
      return (
        <Readout
          caption={(c.showLabel ?? true) ? d.name ?? d.channelId : null}
          value={headline ?? quals[0] ?? "—"}
          sub={(headline ? quals : quals.slice(1)).join("  ") || null}
          valueColor={
            battery && d.battery != null ? batteryColor(d.battery)
            : runtime ? runtimeColor(d.batteryMinutes)
            : null
          }
          mono
          dim={!d.online}
            align={o.style?.textAlign}
        />
      );
    }
    case "scores":
      return <ScoresObject config={c} scores={ctx.scores} />;

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
  align,
}: {
  config: Extract<LayoutObjectConfig, { type: "spl-meter" }>;
  spl: SplMetricsDTO | null;
  align: LayoutHAlign | undefined;
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
  if (shown == null) return <Readout caption={config.caption} value="— dB" dim mono align={align} />;
  const color = splThresholdColor(shown, config.thresholds);
  // "pk" and the metric name were two inline 0.6em spans trailing the number, so
  // a meter with both read "97 dB pk SPL-A" as one run of text at three sizes.
  // They are one sub-line now, which is what they always were.
  const quals = [config.peakHold ? "peak hold" : null, config.showLabel && r ? r.metricKey : null].filter(Boolean);
  return (
    <Readout
      caption={config.caption}
      value={`${Math.round(shown)} dB`}
      sub={quals.join(" · ") || null}
      valueColor={color}
      mono
            align={align}
    />
  );
}

function hhmm(iso: string): string {
  return formatClock(iso);
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
  now,
  align,
}: {
  state: BaptismState | null;
  config: Extract<LayoutObjectConfig, { type: "baptism-timer" }>;
  now: number;
  align: LayoutHAlign | undefined;
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
  // "0:00 avg per person" on a narrow tile was 49px wider than the tile in the
  // measured sweep, because the label rode on the end of the value and the pair
  // was fitted as one string. Under the value it is a line of its own, and the
  // value is sized from the box rather than from how long the label happens
  // to be.
  return (
    <Readout
      caption={config.caption}
      value={value}
      sub={config.showLabel ? config.label ?? fallback : null}
      mono
            align={align}
    />
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

/** Runtime remaining as `H:MM`, the way Wireless Workbench writes it. Always
 *  with the hour, so a column of packs stays a column and 0:45 cannot be
 *  misread as 45 hours. */
export function runtimeText(minutes: number | null | undefined): string | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return null;
  const whole = Math.floor(minutes);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Runtime remaining, coloured by whether it survives what is in front of it.
 *
 * The thresholds are a service, not a percentage: 90 minutes covers a service
 * with a margin, an hour covers one that has already started, and under half an
 * hour is a pack somebody has to go and swap. A percentage cannot say this — the
 * same 60% is three hours on one pack and forty minutes on another.
 */
export function runtimeColor(minutes: number | null): string | null {
  if (minutes == null) return null;
  if (minutes >= 90) return "var(--green-10)";
  if (minutes >= 30) return "var(--yellow-10)";
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
 * WHICH kinds draw, and what stops the recursion, are no longer this object's
 * business. EmbeddedView answers both, and the `screen-embed` object asks it the
 * same question — so a kind that draws in one tile draws in every tile.
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

  // The embedded view's canvas is the BOX, not the screen. A custom view is
  // drawn by the same RenderObject a display uses, and everything that sizes
  // itself there — fonts, spacing — is a fraction of ctx.H. Left as the parent's
  // H, a quarter-height tile drew its child four times too large: correct-looking
  // markup, unreadable output. See useEmbedBoxHeight for why it is measured.
  const { ref: boxRef, height: boxH } = useEmbedBoxHeight(view?.id ?? null);

  // Before the early returns: a hook cannot be called conditionally. And gated
  // on `view`, not just on `interactive` — the SAME reason screen-embed passes
  // its `expandable` in rather than wrapping the hook's output. Gated only on
  // the way out, deleting a view while its tile was expanded left an invisible
  // "expanded": the panel gone, no control to reopen it, a document keydown
  // listener still attached, and the panel springing back by itself if the view
  // came back. Two call sites, one shape, gated the same way at both.
  const { tileRef, control, overlay } = useExpand(ctx.interactive && !!view);

  const notice = (text: string) => <EmbedNotice text={text} />;

  if (!config.viewId) return notice("Pick a view to embed");
  if (!view) return notice("That view no longer exists");

  // ONE body, drawn at whichever pair of heights is asking. Two copies of this
  // JSX would have been two answers to "what does this embed show", and the
  // expanded one is the copy nobody looks at while editing.
  //
  // The two are DIFFERENT numbers on the tile and the same number expanded, so
  // they stay separate parameters: see the note below for why the object's own
  // font size is the parent canvas here, and EmbedFontBox for why an expanded
  // copy has no parent canvas to be a fraction of.
  const body = (canvasH: number, childH: number) => (
    <EmbedFontBox o={o} canvasH={canvasH}>
      <EmbeddedView
        view={view}
        ctx={{ ...ctx, H: childH }}
        showHeader={config.showHeader ?? false}
        autoScroll={config.autoScroll ?? true}
      />
    </EmbedFontBox>
  );

  // w-full h-full, not the object's alignment: boxStyle turns every object into
  // a flex column aligned by textAlign, which shrink-wraps a child that has no
  // width of its own — a left-aligned box rendered the rundown at about half the
  // width it was given. An embed always fills its box; alignment is a text idea
  // and does not apply.
  //
  // The font size is set HERE, on the wrapper, and inherited by the whole
  // embedded view. Every other object applies it per text node through textStyle,
  // which an embedded component never passes through — so without this the
  // rundown fell back to the browser default 16px however large the object was,
  // with no control that did anything.
  // The wrapper's own font size stays a fraction of ctx.H: it is the OBJECT's
  // style, sized against the canvas exactly as every other object's font size
  // is, and it is the operator's control over the embed. Only the child view's
  // canvas is the box.
  //
  // `relative`, so the expand control can sit in the corner without being an
  // ancestor of anything the view draws. It is absolutely positioned and adds no
  // height, so the box measurement below is untouched.
  return (
    <div ref={tileRef} className="relative w-full h-full">
      <div ref={boxRef} className="w-full h-full">{body(ctx.H, boxH || ctx.H)}</div>
      {/* Each object gates on the states IT resolves — a missing view here, an
          unrouted or blacked-out screen there. The notices EmbeddedView emits
          for itself (a per-display kind, a recursion refusal, an empty view) are
          gated by neither, deliberately: the alternative is a second copy of its
          kind switch, which is the duplication this file keeps paying for.
          Expanding one of those enlarges the same sentence, which is harmless;
          a screen tile's states are gated because they change mid-service. */}
      {control(view.name)}
      {overlay((panelH) => body(panelH || ctx.H, panelH || ctx.H), view.name)}
    </div>
  );
}

/**
 * What another screen is showing, right now.
 *
 * Resolves output -> its routed view -> EmbeddedView, so it follows a routing
 * change without anyone touching this layout. That is the whole difference from
 * view-embed, and it is why this is the object a producer wall is built from.
 * It is also the only way the per-display kinds — dashboard, stage, SPL rundown
 * — can be embedded at all, because each is configured against a display id and
 * a view-embed has none to give.
 *
 * Each not-showing state is NAMED. A tile that draws an empty box for "unrouted"
 * and an empty box for "deleted" and an empty box for "blacked out" is three
 * different problems wearing one face, at the moment somebody is trying to work
 * out what is wrong with a screen.
 */
function ScreenEmbedObject({
  o,
  config,
  ctx,
}: {
  o: LayoutObject;
  config: Extract<LayoutObjectConfig, { type: "screen-embed" }>;
  ctx: LayoutRenderCtx;
}) {
  // From `outputs`, which is what the server derives resolvedByOutput from — the
  // routing, the blackout flag and the screen's NAME all come off the one record
  // rather than being joined back together from two.
  const output = config.outputId ? ctx.state.outputs?.find((x) => x.id === config.outputId) ?? null : null;
  const view = output?.viewId ? ctx.state.views?.find((v) => v.id === output.viewId) ?? null : null;
  const showing = Boolean(view) && !output?.blackout;
  // Deliberately not folded into `showing`: a screen can be connected and
  // blacked out, or routed and unplugged, and the tile has to be able to say so.
  const connected = output !== null && ctx.onlineOutputIds.includes(output.id);

  // Measured on the BODY, not the tile: the label bar takes real height, and a
  // child sized against the whole tile overflows by exactly that much.
  const { ref: boxRef, height: boxH } = useEmbedBoxHeight(view?.id ?? null);
  const notice = (text: string) => <EmbedNotice text={text} />;

  // Guard clauses, in the order the screen itself resolves. Blackout comes BEFORE
  // the routing check because a blacked-out screen shows black whatever it is
  // routed to — read as an order, not counted out of nested ternary indentation.
  const content = (childH: number) => {
    if (!config.outputId) return notice("Pick a screen to show");
    if (!output) return notice("That screen no longer exists");
    if (output.blackout) return notice("Blackout");
    if (!view) return notice(`"${output.name}" is not showing anything`);
    return <EmbeddedView view={view} ctx={{ ...ctx, H: childH }} displayId={output.id} />;
  };

  // The font box wraps the body rather than the whole tile: the overlay is a
  // portal to document.body and inherits nothing from this tile's wrapper,
  // however the React tree reads. Same two heights view-embed takes.
  const body = (canvasH: number, childH: number) => (
    <EmbedFontBox o={o} canvasH={canvasH}>{content(childH)}</EmbedFontBox>
  );

  // Only when there is something to enlarge. A blacked-out, unrouted or deleted
  // screen's whole content is one sentence, and full-screening a sentence is a
  // control that does nothing. `showing` already implies `output`; the ternary
  // is what tells the type checker so.
  //
  // The gate goes INTO the hook rather than around its output. Gated only on the
  // way out, an operator who expanded a tile and then blacked that screen out
  // kept an invisible "expanded": no control to reopen it, a document key
  // listener still attached, and the panel springing back to full screen by
  // itself the moment the blackout cleared.
  const expandable = showing ? output : null;
  const { tileRef, control, overlay } = useExpand(ctx.interactive && expandable !== null);

  return (
    <div
      ref={tileRef}
      // `relative`, so the expand control sits in the corner as a SIBLING of the
      // body rather than an ancestor of it. Absolutely positioned, so it adds no
      // height and the body measurement is untouched.
      className="relative flex h-full w-full flex-col overflow-hidden"
    >
      {config.showLabel !== false && output && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
          {config.showStatus !== false && (
            // A browser is attached — the heartbeat, not the routing.
            //
            // This dot used to mean "routed and not blacked out", on the
            // reasoning that nothing in the app knew whether a screen was
            // actually up. display-presence.ts always did, and so the dot spent
            // its life reassuring a producer about screens that were switched
            // off. Routed and connected are independent facts and the tile keeps
            // them apart: the BODY names what the screen is or is not showing
            // ("Blackout", "…is not showing anything"), and the dot answers the
            // one question the body cannot — is anybody there.
            <span
              className={`size-1.5 shrink-0 rounded-full ${connected ? "bg-live-9" : "bg-fg-faint"}`}
              aria-label={connected ? "Connected" : "Not connected"}
            />
          )}
          <span className="truncate text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
            {output.name}
          </span>
        </div>
      )}
      <div ref={boxRef} className="min-h-0 flex-1">{body(ctx.H, boxH || ctx.H)}</div>
      {expandable && control(expandable.name)}
      {expandable &&
        overlay((panelH) => body(panelH || ctx.H, panelH || ctx.H), expandable.name)}
    </div>
  );
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

/** Collect the set of object `config.type`s present in a layout so live-data
 *  hooks can be gated to only the channels the layout actually renders.
 *
 *  Recurses into container children AND through both embed objects into the
 *  layouts they draw, because a widget in a tile is every bit as on-screen as
 *  one on the canvas. Without the descent, an OBS badge inside a producer
 *  multiview asked for a channel nobody subscribed to and sat dead for ever.
 *
 *  The cheap alternative — naming `view-embed`/`screen-embed` in every gate —
 *  makes any layout containing one tile subscribe to everything, which is the
 *  efficiency these gates exist to buy.
 *
 *  @param views   every View, so an embed's target can be resolved. Passed in
 *    rather than read from a module-level store: this is a pure function, and
 *    the caller (useLayoutData) already holds the state.
 *  @param outputs every Output, so a screen-embed can be resolved the way the
 *    tile itself resolves it — output -> its routed view.
 *  @param chain   the views already being drawn above this layout, outermost
 *    first — the SAME chain the renderer carries in `ctx.embedChain`.
 */
function collectLayoutTypes(
  objects: LayoutObject[] | undefined,
  into: Set<string>,
  views: readonly View[],
  outputs: readonly Output[],
  chain: readonly string[],
): void {
  /** One level in, guarded by embed-chain — the renderer's own limiter, not a
   *  second one. A view that would be REFUSED on screen draws nothing, so it
   *  needs no channels; and cycles terminate here for the same reason they
   *  terminate there. Two limiters that disagree would be worse than one: the
   *  gate would either starve a tile that draws or subscribe for one that does
   *  not. */
  const descend = (viewId: string | null | undefined) => {
    if (!viewId || embedRefusal(viewId, chain)) return;
    const view = views.find((v) => v.id === viewId);
    // Only a CUSTOM view draws objects. Every other kind is a whole component
    // with its own hooks, and a view that used to be custom can still be
    // carrying the layout it had then — collecting that would gate channels on
    // objects nobody can see.
    const layout = view?.kind === "custom" ? view.layout : undefined;
    if (!layout) return;
    collectLayoutTypes(layout.objects, into, views, outputs, childChain(viewId, chain));
  };

  for (const o of objects ?? []) {
    const config = o.config;
    if (config?.type) into.add(config.type);
    if (o.children?.length) collectLayoutTypes(o.children, into, views, outputs, chain);
    if (config?.type === "view-embed") descend(config.viewId);
    // Resolved through the OUTPUT, exactly as the tile does, so a routing change
    // moves the gates with it rather than leaving the new view's widgets dark.
    else if (config?.type === "screen-embed") descend(outputs.find((x) => x.id === config.outputId)?.viewId);
  }
}

/**
 * Which object types a layout actually puts on screen, embedded views included.
 *
 * Deliberately WIDER than the render, in two places, and neither is a bug to be
 * tidied up later:
 *
 *   HIDDEN objects count. Every renderer filters `o.hidden` on the way out; this
 *   does not, so a hidden meter still holds its channel open. Unhiding is one
 *   click, mid-service, and a widget that appears and then sits blank until a
 *   subscription catches up is worse than a channel nobody is reading.
 *
 *   A BLACKED-OUT screen tile counts. It draws the word "Blackout" and nothing
 *   else, but blackout is a momentary command from Companion and un-blacking has
 *   to restore the picture instantly, not start subscribing.
 *
 * Exported for the guard suite: the gates below are a set membership test, so
 * this set IS the behaviour worth testing, and testing it needs no React.
 *
 * @param viewId the View this layout belongs to — it seeds the embed chain, the
 *   same way LayoutRenderer seeds `ctx.embedChain`. Absent (Home, the editor)
 *   means nothing is above this layout.
 */
export function layoutChannelTypes(
  layout: LayoutDTO,
  views: readonly View[],
  outputs: readonly Output[],
  viewId?: string | null,
): Set<string> {
  const into = new Set<string>();
  collectLayoutTypes(layout.objects, into, views, outputs, viewId ? [viewId] : []);
  return into;
}

/** Live data + tickers shared by the kiosk renderer and the settings editor.
 *  When a `layout` is passed (kiosk display), the optional/high-frequency data
 *  hooks are gated to the object types the layout contains — so a clock-only
 *  display doesn't subscribe to (or re-render on) SPL/transcript/wireless/etc.
 *  Called with no arg (editor) → every hook is enabled so previews always show data. */
export function useLayoutData(layout?: LayoutDTO, viewId?: string | null) {
  // The state comes FIRST, before the gates that used to be computed above it:
  // an embedded view's objects live in `state.views`, and a gate that cannot see
  // them leaves every widget inside a tile without a channel.
  const { state, isLoading, error, pcoLive, propresenter } = useDashboardState();
  const views = state?.views;
  const outputs = state?.outputs;
  // `views`/`outputs` are fresh array identities on every state broadcast, so
  // this walk runs per broadcast rather than per layout change. Left that way
  // deliberately, and measured: a deliberately heavy shape — thirty views of
  // forty objects, four embeds per level fanning out to the depth cap — walks in
  // 0.054 ms, and broadcasts are change-driven rather than a poll. Narrowing the
  // dependency would mean deriving a signature from the same fields the walk
  // reads, which is the same walk wearing a hat. The result feeds only the
  // `want()` booleans, so an identical set re-derived changes nothing downstream
  // and no subscription is torn down.
  const types = useMemo(() => {
    if (!layout) return null; // editor / unknown → enable everything
    return layoutChannelTypes(layout, views ?? [], outputs ?? [], viewId);
  }, [layout, views, outputs, viewId]);
  const want = (kinds: string[]) => types === null || kinds.some((k) => types.has(k));
  const peopleWanted = want(["people-counter", "people-graph", "people-panel"]);

  const transcript = useTranscript(want(["transcript-strip"]));
  const spl = useSplState(want(["spl-meter"]));
  const obs = useObsState(want(["obs-status"]));
  const reaper = useReaperState(want(["reaper-status"]));
  // Gated harder than most: the channel's DEMAND is what decides the poll cadence
  // at the server, so an ungated hook would hold PVP at 1 Hz for a wall screen
  // showing a clock.
  const pvp = usePvpState(want(["pvp-layers"]));
  // PVP's own clock offset. The shared skewMs below is PCO-derived and is 0
  // whenever PCO is off, which would leave every PVP bar comparing a server
  // timestamp against the browser's clock.
  const pvpSkewMs = usePvpSkewMs(pvp);
  // Gated like every other integration hook: a clock-only wall screen must not
  // hold a poll open against ESPN.
  const scores = useScoresState(want(["scores", "home-scores"]));
  // Both gated on the streaming objects: a clock-only wall screen must not hold
  // a poll open against two cloud APIs, one of which has a daily quota.
  const streamWanted = want(["stream-status", "home-streaming", "home-streaming-resi", "home-streaming-youtube"]);
  const resi = useResiState(streamWanted);
  const youtube = useYouTubeState(streamWanted);
  const osc = useOscState(want(["osc-button"]));
  const peopleCount = usePeopleCountState(peopleWanted);
  const serviceLow = useLiveServiceLow(peopleWanted);
  const serviceAttendance = useLiveServiceAttendance(peopleWanted);
  const servicePeaks = useLiveServicePeaks(peopleWanted);
  const wireless = useWirelessTelemetry(want(["wireless-summary", "wireless-channel"]));
  // The screen tile's status dot, Home's screens count and Home's readiness list
  // are the only things that draw presence — so a wall of clocks subscribes to
  // nothing, which was the whole objection to wiring this up at all.
  //
  // "view-embed" was in this list too, as a stand-in for the descent that did
  // not exist: a screen tile nested inside an embedded view was invisible to the
  // gate and its dot never lit. collectLayoutTypes now walks into embedded
  // layouts, so that tile reports "screen-embed" on its own and the stand-in is
  // gone — a view-embed of a clock no longer opens the presence channel.
  const onlineOutputIds = useDisplayPresence(want(["screen-embed", "home-screens", "home-readiness"]));
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

  return { state, isLoading, error, pcoLive, propresenter, propInstances, planItems, transcript, spl, obs, reaper, pvp, pvpSkewMs, resi, youtube, osc, scores, peopleCount, serviceLow, serviceAttendance, servicePeaks, baptism, serviceTimeline, integrationsSnap, wireless, onlineOutputIds, now, skewMs };
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
  viewId,
}: {
  layout: LayoutDTO;
  ndiSource: string | null;
  interactive?: boolean;
  /** The View's surface, so a console can respond to the window while a display
   *  honours its design. Absent behaves as a display — the safe default. */
  surface?: "display" | "console";
  /**
   * Which View this layout belongs to — it SEEDS the embed chain.
   *
   * Required rather than optional, exactly like `embedChain` above and for the
   * same reason: an optional field defaulting a caller to `embedChain: []`
   * lets a surface forget it, and a forgotten seed is indistinguishable from
   * "nothing above me" — the one answer that makes a tile pointing back at the
   * view it lives on undetectable as a cycle. It then draws a second copy of
   * the whole layout inside itself and only the depth cap stops it. Verified
   * in a browser, which is the only place it shows — every unit test builds
   * the chain by hand and so agrees with whatever the component does.
   */
  viewId: string | null;
}) {
  const { state, isLoading, error, pcoLive, propresenter, propInstances, planItems, transcript, spl, obs, reaper, pvp, pvpSkewMs, resi, youtube, osc, scores, peopleCount, serviceLow, serviceAttendance, servicePeaks, baptism, serviceTimeline, integrationsSnap, wireless, onlineOutputIds, now, skewMs } = useLayoutData(layout, viewId);

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

  // NOT Home: Home draws its own grid with ObjectContent directly (see
  // home-grid), and /consoles/home redirects to it. Anything reaching this
  // renderer is a console, a display, or a preview of one.
  const ctx: LayoutRenderCtx = { home: false, embedChain: viewId ? [viewId] : [], state, propresenter, propInstances, pcoLive, planItems, transcript, spl, obs, reaper, pvp, pvpSkewMs, resi, youtube, osc, scores, peopleCount, serviceLow, serviceAttendance, servicePeak: servicePeaks.occupancy, servicePeakAttendance: servicePeaks.attendance, baptism, serviceTimeline, integrations: integrationsSnap.states, integrationLabels: integrationsSnap.labels, wireless, onlineOutputIds, now, skewMs, ndiSource, H, interactive, placed };
  const objects = [...layout.objects].filter((o) => !o.hidden).sort((a, b) => a.z - b.z);

  return (
    <div
      ref={setBox}
      // ALWAYS the kiosk surface, never the app's theme background.
      //
      // A console used to be drawn on `bg-bg` so it read as part of the page
      // rather than a slab of stage-black bolted into it. That reasoning held
      // while the app was dark: measured, `--color-bg` is #0e0e0e against the
      // kiosk's #0a0a0a, four points apart and indistinguishable.
      //
      // In LIGHT mode the same token is #f7f8fa, and a layout's objects carry
      // colours somebody authored against a dark canvas — white text, most of
      // it. The ground inverted and the text stayed white, so a console on a
      // phone in daylight was white-on-white. The editor never showed this,
      // because it draws on the kiosk surface: what you designed was not what
      // you got.
      //
      // A layout brings its own ground with it. `canvas.background` is where an
      // operator says what that is; the app's theme does not get a vote.
      className={`relative w-full h-full flex items-center justify-center kiosk-surface ${
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
