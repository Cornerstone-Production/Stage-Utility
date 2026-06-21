import { useState, useEffect, type CSSProperties } from "react";
import { BrandLogo } from "../components/brand-logo";
import { SlotsColumns } from "../components/slots-columns";
import { useDashboardState } from "./use-dashboard-state";
import { useTranscript } from "./use-transcript";
import { computePcoTimer, fmtDuration } from "./pco-timer";
import { channelLabel, lineColor } from "./channel-color";
import { TranscriptFeed } from "./transcript-feed";
import { LiveControls } from "./live-controls";
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
    return `${h}:${m}${showSeconds ? `:${s}` : ""}${showMeridiem ? ` ${ampm}` : ""}`;
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
      return span(clockText(ctx.now, c.showSeconds ?? true, c.format ?? "12h", c.showMeridiem ?? true));
    case "countdown-timer": {
      const t = computePcoTimer(ctx.pcoLive, ctx.now, ctx.skewMs);
      return span(t ? fmtDuration(t.seconds) : "—");
    }
    case "current-slide-text":
      return span(ctx.propresenter?.currentSlideText ?? ctx.propresenter?.currentItem ?? "");
    case "next-slide-text":
      return span(ctx.propresenter?.nextSlideText ?? ctx.propresenter?.nextItem ?? "");
    case "current-service-item":
      return span(ctx.propresenter?.currentServiceItem ?? "");
    case "next-service-item":
      return span(ctx.propresenter?.nextServiceItem ?? "");
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
        // Multi-speaker feed: newest at the bottom, older shifting up — same
        // behavior as the full transcription view, sized to this object's box.
        return (
          <TranscriptFeed
            lines={ctx.transcript}
            maxLines={c.maxLines ?? 3}
            showLabels
            textStyle={ts}
            gapClassName="gap-[0.3em]"
            className="w-full h-full"
          />
        );
      }
      const last = ctx.transcript[ctx.transcript.length - 1];
      const speaker = channelLabel(last);
      return (
        <span style={{ ...ts, color: lineColor(last), opacity: last.isFinal ? 1 : 0.55 }}>
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
      // Render via the same component the standalone slots view uses, honoring the
      // source View's physical-inch alignment, over the kiosk backdrop so it looks
      // identical (grey, not navy). `.kiosk-surface` paints the kiosk gradient.
      const srcView = c.sourceViewId ? (ctx.state.views?.find((v) => v.id === c.sourceViewId) ?? null) : null;
      return (
        <SlotsColumns
          slots={slots}
          slotsLayout={srcView?.slotsLayout ?? null}
          emptySlotLogo={ctx.state.emptySlotLogo}
          defaultAvatar={ctx.state.defaultAvatar}
          className="w-full h-full kiosk-surface"
        />
      );
    }
    default:
      return null;
  }
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
  const doc = await pdfjs.getDocument({ data }).promise;
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
    await page.render({ canvasContext: c2d, viewport }).promise;
    return canvas;
  } finally {
    void doc.destroy();
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
export function LayoutRenderer({ layout, ndiSource, interactive = false }: { layout: LayoutDTO; ndiSource: string | null; interactive?: boolean }) {
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
  const ctx: LayoutRenderCtx = { state, propresenter, pcoLive, transcript, now, skewMs, ndiSource, H: canvas.height, interactive };
  const objects = [...layout.objects].filter((o) => !o.hidden).sort((a, b) => a.z - b.z);

  // Default/legacy canvas backgrounds inherit the shared kiosk surface so custom
  // layouts match every other view; only an explicit non-default solid overrides.
  const bg = canvas.background;
  const inheritSurface = bg == null || bg === "#000" || bg === "#000000" || bg === "#080810";

  return (
    <div ref={setBox} className="relative w-full h-full kiosk-surface overflow-hidden flex items-center justify-center">
      <div
        style={{
          width: canvas.width,
          height: canvas.height,
          background: inheritSurface ? "transparent" : bg,
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
