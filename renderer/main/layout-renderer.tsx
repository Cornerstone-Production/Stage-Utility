import { useState, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { BrandLogo } from "../components/brand-logo";
import { SlotsColumns } from "../components/slots-columns";
import { useDashboardState } from "./use-dashboard-state";
import { useSplState, resolveSplValue } from "./use-spl-state";
import { useObsState } from "./use-obs-state";
import { useOscState, resolveOscActive } from "./use-osc-state";
import { usePeopleCountState, resolvePeopleValue, useServiceAvgOccupancy, useLiveServiceLow } from "./use-people-count-state";
import { useBaptismState, summarizeBaptism, fmtClock } from "./use-baptism-state";
import { useIntegrations } from "./use-integration-states";
import { useWirelessChannels } from "./use-wireless-channels";
import { OscButton } from "./osc-button";
import { useTranscript } from "./use-transcript";
import { usePlanItems } from "./use-plan-items";
import { computePcoTimer, fmtDuration } from "./pco-timer";
import { channelLabel, lineColor } from "./channel-color";
import { TranscriptFeed } from "./transcript-feed";
import { LiveControls } from "./live-controls";
import { Loader2Icon, ZapIcon } from "lucide-react";

// Render context shared by every object renderer.
export interface LayoutRenderCtx {
  state: StageState;
  propresenter: ProPresenterStatusDTO | null;
  pcoLive: PcoLiveDTO | null;
  /** Current PCO plan rundown (items + note categories) — for the service-order object. */
  planItems: PlanItemsDTO | null;
  transcript: TranscriptLineDTO[];
  spl: SplMetricsDTO | null;
  obs: ObsStatusDTO | null;
  osc: OscFeedbackDTO | null;
  /** Live SenSource Vea people counts — for the people-counter object. */
  peopleCount: PeopleCountDTO | null;
  /** Lowest in-room occupancy during the current/most-recent live service — the
   *  "Low" metric (replaces the useless whole-day minimum). null when none. */
  serviceLow: number | null;
  /** Live baptism-timer state — for the baptism-timer object. */
  baptism: BaptismState | null;
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
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Box-level CSS (position handled by caller): background, border, radius, padding,
 *  opacity, and flex alignment derived from text/vertical alignment. */
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
  if (s.opacity != null) css.opacity = s.opacity;
  if (s.padding != null) css.padding = `${s.padding * H}px`;
  if (s.cornerRadius != null) css.borderRadius = `${s.cornerRadius * H}px`;
  // Clamp so a stray/legacy width can't swell into a solid fill.
  if (s.borderColor && s.borderWidth) css.border = `${Math.min(s.borderWidth, 0.04) * H}px solid ${s.borderColor}`;
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
  return (
    <div
      style={{
        position: "absolute",
        left: `${o.x * 100}%`,
        top: `${o.y * 100}%`,
        width: `${o.w * 100}%`,
        height: `${o.h * 100}%`,
        ...boxStyle(o, ctx.H),
      }}
    >
      {kids ? kids.map((c) => <RenderObject key={c.id} o={c} ctx={ctx} />) : <ObjectContent o={o} ctx={ctx} />}
    </div>
  );
}

/** Render one object's inner content (the positioned box wraps this). */
export function ObjectContent({ o, ctx }: { o: LayoutObject; ctx: LayoutRenderCtx }) {
  const c = o.config;
  const ts = textStyle(o, ctx.H);
  const span = (text: string) => <span style={ts}>{text}</span>;

  switch (c.type) {
    case "text":
      return span(c.text);
    case "clock":
      return span(clockText(ctx.now, c.showSeconds ?? true, c.format ?? "12h", c.showMeridiem ?? true));
    case "countdown-timer": {
      const t = computePcoTimer(ctx.pcoLive, ctx.now, ctx.skewMs);
      if (!t) return (c.hideWhenIdle ?? false) ? null : span("—");
      // Red once the timer goes negative (item or service ran over), like the
      // dashboard; amber once it drops to/below the configured warning; else keep
      // the object's configured color.
      const warning = c.warnSeconds != null && !t.over && t.seconds <= c.warnSeconds;
      const color = t.over ? "var(--red-10)" : warning ? "var(--yellow-10)" : null;
      return (
        <span style={color ? { ...ts, color } : ts}>
          {fmtDuration(t.seconds)}
        </span>
      );
    }
    case "current-slide-text":
      return span(ctx.propresenter?.currentSlideText ?? ctx.propresenter?.currentItem ?? "");
    case "next-slide-text":
      return span(ctx.propresenter?.nextSlideText ?? ctx.propresenter?.nextItem ?? "");
    case "current-service-item":
      // Follow the PCO plan order (authoritative); fall back to ProPresenter's
      // active playlist only when PCO has no current item.
      return span(ctx.pcoLive?.currentItemTitle ?? ctx.propresenter?.currentServiceItem ?? "");
    case "next-service-item":
      return span(ctx.pcoLive?.nextItemTitle ?? ctx.propresenter?.nextServiceItem ?? "");
    case "service-order":
      return <ServiceOrderObject o={o} config={c} ctx={ctx} />;
    case "current-slide-notes":
      return span(ctx.propresenter?.currentNotes ?? "");
    case "section-chip": {
      const sec =
        c.which === "next"
          ? ctx.propresenter?.nextSection
          : c.which === "nextArrangement"
            ? ctx.propresenter?.nextArrangementSection
            : ctx.propresenter?.currentSection;
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
    case "slide-thumbnail": {
      const key = ctx.propresenter?.slidePreviewKey;
      if (!key) return null;
      return (
        <img
          src={`/api/propresenter/thumbnail?k=${encodeURIComponent(key)}`}
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
      // "min" now means "lowest in-room during the live service" (building-wide),
      // sourced from the attendance record — not the useless whole-day minimum.
      const value = metric === "min" ? ctx.serviceLow : resolvePeopleValue(ctx.peopleCount, metric, c.zoneId);
      if (value == null) return <span style={{ ...ts, opacity: 0.4 }}>—</span>;
      const fallbackLabel =
        metric === "occupancy" ? "in room" : metric === "peak" ? "peak" : metric === "min" ? "low" : metric === "avg" ? "avg" : "people";
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
      return <PeopleGraph history={ctx.peopleCount?.history ?? []} metric={c.metric ?? "occupancy"} config={c} ts={ts} H={ctx.H} />;
    case "people-panel":
      return <PeoplePanel config={c} people={ctx.peopleCount} serviceLow={ctx.serviceLow} ts={ts} H={ctx.H} />;
    case "baptism-timer":
      return <BaptismTimer state={ctx.baptism} config={c} ts={ts} now={ctx.now} />;
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
        if (c.fillWhenRecording ?? true) {
          return (
            <div style={{ ...ts, color: "#ffffff", background: "var(--red-9)", width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "inherit" }}>
              {label}
            </div>
          );
        }
        return <span style={{ ...ts, color: "var(--red-10)" }}>{label}</span>;
      }
      // Idle: dim when offline so a neutral badge is never mistaken for "not
      // active" when OBS is merely unreachable.
      return (
        <span style={{ ...ts, opacity: connected ? 1 : 0.4 }}>
          {connected ? (c.idleText ?? idleDefault) : (c.offlineText ?? "OBS: Offline")}
        </span>
      );
    }
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
        : "rgba(255,255,255,0.35)";
      const name = c.label ?? (st ? (ctx.integrationLabels[st.id] ?? st.id) : "—");
      return (
        <span style={{ ...ts, width: "auto", display: "inline-flex", alignItems: "center", gap: "0.4em" }}>
          <span style={{ width: "0.6em", height: "0.6em", borderRadius: "50%", background: dot, flexShrink: 0 }} />
          {(c.showLabel ?? true) && <span>{name}</span>}
        </span>
      );
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
    default:
      return null;
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
  const peak = useRef<number | null>(null);
  useEffect(() => {
    peak.current = null; // reset the hold when the source or mode changes
  }, [config.meterId, config.metricKey, config.peakHold]);
  if (config.peakHold && r) {
    peak.current = peak.current == null ? r.value : Math.max(peak.current, r.value);
  }
  const shown = config.peakHold ? peak.current : (r?.value ?? null);
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
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
function PeopleGraph({
  history,
  metric,
  config,
  ts,
  H,
}: {
  history: PeopleHistoryPoint[];
  metric: "attendance" | "occupancy";
  config: Extract<LayoutObjectConfig, { type: "people-graph" }>;
  ts: CSSProperties;
  H: number;
}) {
  const vals = history.map((h) => (metric === "attendance" ? h.attendance : h.occupancy));
  if (vals.length < 2) return <span style={{ ...ts, opacity: 0.4 }}>—</span>;
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

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block" }}>
        {/* gridlines at lo / mid / hi */}
        {[PADT, PADT + (100 - PADT - PADB) / 2, 100 - PADB].map((y, i) => (
          <line key={i} x1={PADL} y1={y} x2={100 - PADR} y2={y} stroke={stroke} strokeOpacity={0.18} strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
        ))}
        <polygon points={`${PADL},${100 - PADB} ${line} ${100 - PADR},${100 - PADB}`} fill={stroke} fillOpacity={0.13} />
        <polyline points={line} fill="none" stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>

      {/* y-axis value labels (crisp HTML overlays) */}
      <span style={labelStyle(yTop)}>{yLabel(hi)}</span>
      <span style={labelStyle(yMidPct)}>{yLabel(mid)}</span>
      <span style={labelStyle(yBot)}>{yLabel(lo)}</span>

      {/* x-axis time labels */}
      <span style={{ position: "absolute", left: `${PADL}%`, bottom: 0, color: stroke, opacity: 0.7, fontSize: `${fontPx}px`, lineHeight: 1 }}>{hhmm(history[0].t)}</span>
      <span style={{ position: "absolute", right: `${PADR}%`, bottom: 0, color: stroke, opacity: 0.7, fontSize: `${fontPx}px`, lineHeight: 1 }}>{hhmm(history[n - 1].t)}</span>

      {/* current value readout (top-right, clear of the y-max label) */}
      {config.showLabel && (
        <span style={{ position: "absolute", top: 0, right: `${PADR}%`, color: stroke, fontSize: `${fontPx * 1.3}px`, fontWeight: 700, lineHeight: 1, opacity: 0.95 }}>
          {(config.label ? `${config.label} ` : "") + vals[n - 1].toLocaleString()}
        </span>
      )}
    </div>
  );
}

// A multi-metric people summary: several building-wide counts side by side (or
// stacked), each value over a small label. All building-level (peak/min/avg are
// not per-zone). avgService = mean peak across recorded services.
const PEOPLE_PANEL_LABELS: Record<string, string> = {
  occupancy: "In room",
  peak: "Peak",
  attendance: "Attendance",
  min: "Low",
  avg: "Avg today",
  avgService: "Avg / service",
  capacity: "Capacity",
  vsAverage: "vs avg",
};
function PeoplePanel({
  config,
  people,
  serviceLow,
  ts,
  H,
}: {
  config: Extract<LayoutObjectConfig, { type: "people-panel" }>;
  people: PeopleCountDTO | null;
  serviceLow: number | null;
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
      k === "avgService" ? serviceAvg : k === "min" ? serviceLow : ((t as Record<string, number | null> | undefined)?.[k] ?? null);
    return { text: v == null ? "—" : v.toLocaleString(), color: base };
  };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: col ? "column" : "row",
        flexWrap: "wrap",
        gap: `${0.04 * H}px ${0.06 * H}px`,
        width: "100%",
        height: "100%",
        justifyContent: "space-evenly",
        alignItems: "center",
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
    if (state && state.phase !== "idle" && state.segmentStartedAt) {
      value = fmtClock(Math.max(0, now - Date.parse(state.segmentStartedAt)));
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
  return (
    <span style={ts}>
      {value}
      {config.showLabel && <span style={{ opacity: 0.6, fontSize: "0.6em" }}>{` ${config.label ?? fallback}`}</span>}
    </span>
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
    const n = Math.min(Math.max(Math.round(pageNum) || 1, 1), doc.numPages);
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
  const left = Math.max(0, Math.min(0.95, crop.left || 0));
  const right = Math.max(0, Math.min(0.95, crop.right || 0));
  const top = Math.max(0, Math.min(0.95, crop.top || 0));
  const bottom = Math.max(0, Math.min(0.95, crop.bottom || 0));
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

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setStatus("loading");
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
  const fitRef = useRef(1);
  fitRef.current = fitScale;
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
      const desired = Math.max(MIN_FIT, Math.min(1, ch / natural));
      if (Math.abs(desired - cur) > 0.005) setFitScale(desired);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoFit, contentKey, H, fitScale]);

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
              borderLeft: isLive ? `${0.004 * H}px solid var(--green-9, #2dd496)` : `${0.004 * H}px solid transparent`,
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

/** Live data + tickers shared by the kiosk renderer and the settings editor. */
export function useLayoutData() {
  const { state, isLoading, error, pcoLive, propresenter } = useDashboardState();
  const transcript = useTranscript();
  const spl = useSplState();
  const obs = useObsState();
  const osc = useOscState();
  const peopleCount = usePeopleCountState();
  const serviceLow = useLiveServiceLow(true);
  const baptism = useBaptismState();
  const planItems = usePlanItems();
  const integrationsSnap = useIntegrations();
  const wireless = useWirelessChannels();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [skewMs, setSkewMs] = useState(0);
  useEffect(() => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  }, [pcoLive?.serverNow]);

  return { state, isLoading, error, pcoLive, propresenter, planItems, transcript, spl, obs, osc, peopleCount, serviceLow, baptism, integrationsSnap, wireless, now, skewMs };
}

/**
 * Renders a custom-layout View: a fixed design canvas scaled to fit the viewport,
 * with absolutely-positioned, live-data-bound objects.
 */
export function LayoutRenderer({ layout, ndiSource, interactive = false }: { layout: LayoutDTO; ndiSource: string | null; interactive?: boolean }) {
  const { state, isLoading, error, pcoLive, propresenter, planItems, transcript, spl, obs, osc, peopleCount, serviceLow, baptism, integrationsSnap, wireless, now, skewMs } = useLayoutData();

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
  const fill = canvas.fit === "fill";
  const H = fill ? dims.h || canvas.height : canvas.height;
  const ctx: LayoutRenderCtx = { state, propresenter, pcoLive, planItems, transcript, spl, obs, osc, peopleCount, serviceLow, baptism, integrations: integrationsSnap.states, integrationLabels: integrationsSnap.labels, wireless, now, skewMs, ndiSource, H, interactive };
  const objects = [...layout.objects].filter((o) => !o.hidden).sort((a, b) => a.z - b.z);

  // Default/legacy canvas backgrounds inherit the shared kiosk surface so custom
  // layouts match every other view; only an explicit non-default solid overrides.
  const bg = canvas.background;
  const inheritSurface =
    bg == null || bg === "#000" || bg === "#000000" || bg === "#080810" || bg === "#0a0a0a";

  return (
    <div ref={setBox} className="relative w-full h-full kiosk-surface overflow-hidden flex items-center justify-center">
      <div
        style={
          fill
            ? {
                position: "absolute",
                inset: 0,
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
