import { useState, useEffect, type CSSProperties } from "react";
import { SlotPanel } from "../components/slot-panel";
import { BrandLogo } from "../components/brand-logo";
import { useDashboardState } from "./use-dashboard-state";
import { useTranscript } from "./use-transcript";
import { computePcoTimer, fmtDuration } from "./pco-timer";
import { channelLabel } from "./channel-color";
import { Loader2Icon } from "lucide-react";

// Render context shared by every object renderer.
export interface LayoutRenderCtx {
  state: StageState;
  propresenter: ProPresenterStatusDTO | null;
  pcoLive: PcoLiveDTO | null;
  transcript: TranscriptLineDTO[];
  now: number;
  skewMs: number;
  ndiSource: string | null;
  /** Canvas height in design px — basis for fraction→px font/spacing sizing. */
  H: number;
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
  };
  if (s.background) css.background = s.background;
  if (s.opacity != null) css.opacity = s.opacity;
  if (s.padding != null) css.padding = `${s.padding * H}px`;
  if (s.cornerRadius != null) css.borderRadius = `${s.cornerRadius * H}px`;
  if (s.borderColor && s.borderWidth) css.border = `${s.borderWidth * H}px solid ${s.borderColor}`;
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

function clockText(now: number, showSeconds: boolean, format: "12h" | "24h"): string {
  const d = new Date(now);
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  if (format === "12h") {
    const ampm = h < 12 ? "AM" : "PM";
    h = ((h + 11) % 12) + 1;
    return `${h}:${m}${showSeconds ? `:${s}` : ""} ${ampm}`;
  }
  return `${pad(h)}:${m}${showSeconds ? `:${s}` : ""}`;
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
      return span(clockText(ctx.now, c.showSeconds ?? true, c.format ?? "12h"));
    case "countdown-timer": {
      const t = computePcoTimer(ctx.pcoLive, ctx.now, ctx.skewMs);
      return span(t ? fmtDuration(t.seconds) : "—");
    }
    case "current-slide-text":
      return span(ctx.propresenter?.currentSlideText ?? ctx.propresenter?.currentItem ?? "");
    case "next-slide-text":
      return span(ctx.propresenter?.nextSlideText ?? ctx.propresenter?.nextItem ?? "");
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
      if (ctx.transcript.length === 0) return null;
      if (c.mode === "rolling") {
        const lines = ctx.transcript.slice(-(c.maxLines ?? 3));
        return (
          <div className="flex flex-col gap-1 w-full">
            {lines.map((l) => (
              <span key={l.id} style={{ ...ts, opacity: l.isFinal ? 1 : 0.55 }}>
                {l.text}
              </span>
            ))}
          </div>
        );
      }
      const last = ctx.transcript[ctx.transcript.length - 1];
      const speaker = channelLabel(last);
      return span(speaker ? `${speaker}: ${last.text}` : last.text);
    }
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
    case "shape":
      return null; // the box background is the shape
    case "ndi-video":
      return (
        <div className="flex flex-col items-center justify-center w-full h-full bg-black/60 text-white/40">
          <span style={{ fontSize: `${0.03 * ctx.H}px` }}>NDI</span>
          <span style={{ fontSize: `${0.022 * ctx.H}px` }}>{ctx.ndiSource || "no source"}</span>
        </div>
      );
    case "slots-grid": {
      const slots = c.sourceViewId ? (ctx.state.slotsByView?.[c.sourceViewId] ?? []) : [];
      if (slots.length === 0) {
        return <span style={{ ...ts, color: "rgba(255,255,255,0.3)" }}>Mic slots</span>;
      }
      const sorted = [...slots].sort((a, b) => a.order - b.order);
      const columns: Slot[][] = [];
      for (const slot of sorted) {
        if (slot.stackWithPrevious && columns.length > 0) columns[columns.length - 1].push(slot);
        else columns.push([slot]);
      }
      return (
        <div className="flex w-full h-full">
          {columns.map((col, ci) => (
            <div key={col[0]?.id ?? ci} className="flex flex-1 min-w-0 flex-col [container-type:inline-size]">
              {col.map((slot) => (
                <SlotPanel key={slot.id} slot={slot} emptySlotLogo={ctx.state.emptySlotLogo} />
              ))}
            </div>
          ))}
        </div>
      );
    }
    default:
      return null;
  }
}

/** Live data + tickers shared by the kiosk renderer and the settings editor. */
export function useLayoutData() {
  const { state, isLoading, error, pcoLive, propresenter } = useDashboardState();
  const transcript = useTranscript();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [skewMs, setSkewMs] = useState(0);
  useEffect(() => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  }, [pcoLive?.serverNow]);

  return { state, isLoading, error, pcoLive, propresenter, transcript, now, skewMs };
}

/**
 * Renders a custom-layout View: a fixed design canvas scaled to fit the viewport,
 * with absolutely-positioned, live-data-bound objects.
 */
export function LayoutRenderer({ layout, ndiSource }: { layout: LayoutDTO; ndiSource?: string | null }) {
  const { state, isLoading, error, pcoLive, propresenter, transcript, now, skewMs } = useLayoutData();

  // Scale the design canvas to fit the container (letterboxed). Callback ref so
  // the observer attaches when the canvas mounts (after the loading guard).
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!box) return;
    const measure = () => {
      const cw = box.clientWidth;
      const ch = box.clientHeight;
      if (cw > 0 && ch > 0) setScale(Math.min(cw / layout.canvas.width, ch / layout.canvas.height));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [box, layout.canvas.width, layout.canvas.height]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[100dvh] bg-black">
        <Loader2Icon className="size-8 text-gray-7 animate-spin" />
      </div>
    );
  }
  if (error || !state) {
    return (
      <div className="flex items-center justify-center h-[100dvh] bg-black text-gray-7">
        Could not load layout
      </div>
    );
  }

  const { canvas } = layout;
  const ctx: LayoutRenderCtx = { state, propresenter, pcoLive, transcript, now, skewMs, ndiSource: ndiSource ?? null, H: canvas.height };
  const objects = [...layout.objects].filter((o) => !o.hidden).sort((a, b) => a.z - b.z);

  return (
    <div ref={setBox} className="relative w-full h-[100dvh] bg-black overflow-hidden flex items-center justify-center">
      <div
        style={{
          width: canvas.width,
          height: canvas.height,
          background: canvas.background ?? "#000",
          transform: `scale(${scale})`,
          transformOrigin: "center center",
          position: "relative",
          flexShrink: 0,
        }}
      >
        {objects.map((o) => (
          <div
            key={o.id}
            style={{
              position: "absolute",
              left: o.x * canvas.width,
              top: o.y * canvas.height,
              width: o.w * canvas.width,
              height: o.h * canvas.height,
              ...boxStyle(o, canvas.height),
            }}
          >
            <ObjectContent o={o} ctx={ctx} />
          </div>
        ))}
      </div>
    </div>
  );
}
