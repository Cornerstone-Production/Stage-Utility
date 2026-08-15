// Starting layouts and canvas presets.
//
// Pure data and pure builders: no React, no editor state. Split out first
// because it is the seam with no dependencies in either direction — the dialog
// that creates a view imports the templates without wanting the editor.

import type { LayoutObject, LayoutObjectConfig, LayoutStyle } from "@main/types/views";
import { CARD_PRESETS } from "../main/layout-objects";

export function uid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function dashboardTemplate(): LayoutObject[] {
  let z = 0;
  const caption = (text: string): LayoutObject => ({
    id: uid(), x: 0.06, y: 0.1, w: 0.88, h: 0.2, z: 1,
    config: { type: "text", text },
    style: { fontSize: 0.022, fontWeight: 600, color: "#9ca3af", uppercase: true, letterSpacing: 0.1, textAlign: "center", vAlign: "middle" },
  });
  const body = (config: LayoutObjectConfig, color: string, fontSize: number): LayoutObject => ({
    id: uid(), x: 0.06, y: 0.34, w: 0.88, h: 0.56, z: 2,
    config, style: { fontSize, fontWeight: 500, color, textAlign: "center", vAlign: "middle" },
  });
  const tile = (x: number, y: number, w: number, h: number, cap: string, content: LayoutObject): LayoutObject => ({
    id: uid(), x, y, w, h, z: ++z, config: { type: "container" }, style: { ...CARD_PRESETS.neutral },
    children: [caption(cap), content],
  });
  const m = 0.02, g = 0.02;
  const colW = (1 - 2 * m - g) / 2;
  const x1 = m, x2 = m + colW + g;
  const rowH = 0.29, y1 = 0.03, y2 = y1 + rowH + g;
  return [
    tile(x1, y1, colW, rowH, "Current time", body({ type: "clock", showSeconds: true, format: "12h" }, "#ffffff", 0.09)),
    tile(x2, y1, colW, rowH, "Service timer", body({ type: "countdown-timer" }, "#86efac", 0.09)),
    tile(x1, y2, colW, rowH, "Now", body({ type: "current-service-item" }, "#ffffff", 0.05)),
    tile(x2, y2, colW, rowH, "Up next", body({ type: "next-service-item" }, "rgba(255,255,255,0.7)", 0.05)),
    {
      id: uid(), x: m, y: 0.65, w: 1 - 2 * m, h: 0.13, z: ++z,
      config: { type: "container" }, style: { ...CARD_PRESETS.neutral },
      children: [
        { id: uid(), x: 0.02, y: 0.25, w: 0.12, h: 0.5, z: 1, config: { type: "text", text: "SPL" }, style: { fontSize: 0.03, fontWeight: 600, color: "#9ca3af", uppercase: true, letterSpacing: 0.1, textAlign: "left", vAlign: "middle" } },
        { id: uid(), x: 0.15, y: 0.15, w: 0.83, h: 0.7, z: 2, config: { type: "spl-meter", meterId: null, metricKey: null, showLabel: true, thresholds: null }, style: { fontSize: 0.07, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "middle" } },
      ],
    },
    {
      id: uid(), x: m, y: 0.8, w: 1 - 2 * m, h: 0.17, z: ++z,
      config: { type: "container" }, style: { ...CARD_PRESETS.neutral },
      children: [
        { id: uid(), x: 0.03, y: 0.12, w: 0.94, h: 0.76, z: 1, config: { type: "transcript-strip", mode: "rolling", maxLines: 2 }, style: { fontSize: 0.04, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "bottom" } },
      ],
    },
  ];
}

// Build the built-in "Confidence Monitor" starter layout, reproducing the approved
// stage mockup: a top brand bar, a LEFT hero block titled CURRENT holding the current
// item + a huge on-pace-green countdown + a service-progress bar, and a RIGHT rail
// with a NEXT card over a 2×2 grid of readout tiles (Clock / SPL / Slides left /
// Attendance). All coords are canvas fractions (designed for 16:9). Fresh ids.
//
// Notes on object mapping: the "Slides left" tile uses `slide-progress`
// (ProPresenter slide position, "N left") — the closest supported readout to the
// mockup's "Slides left". The hero progress bar likewise uses `slide-progress`
// (display "bar"), which is driven by ProPresenter slide position, standing in for
// the mockup's abstract item-progress bar. The scripture reference + QR code in the
// mockup have no backing object type, so the reference is a plain text label and the
// QR is omitted.
export function confidenceMonitorTemplate(): LayoutObject[] {
  const GREEN = "#46c47e";
  const FG = "rgba(255,255,255,0.95)";
  const FG_MUTED = "rgba(255,255,255,0.56)";
  const FG_FAINT = "rgba(255,255,255,0.30)";
  const ACCENT = "#6aa6df";
  // Glass surface (near-black stage; cards read as faint frosted panels).
  const glass: LayoutStyle = { background: "rgba(255,255,255,0.035)", borderColor: "rgba(255,255,255,0.08)", borderWidth: 0.001, cornerRadius: 0.014 };
  // Uppercase eyebrow/label used above hero + rail sections and on each tile.
  const eyebrow = (color = FG_FAINT): LayoutStyle => ({ fontSize: 0.017, fontWeight: 600, color, uppercase: true, letterSpacing: 0.14, textAlign: "left", vAlign: "middle" });

  let z = 0;
  const obj = (x: number, y: number, w: number, h: number, config: LayoutObjectConfig, style: LayoutStyle, children?: LayoutObject[]): LayoutObject => ({
    id: uid(), x, y, w, h, z: ++z, config, style, ...(children ? { children } : {}),
  });

  // ── top brand bar ──────────────────────────────────────────────────────────
  const bar = obj(0.02, 0.02, 0.96, 0.075, { type: "container" }, { ...glass, background: null, borderColor: null, borderWidth: 0 }, [
    { id: uid(), x: 0, y: 0.15, w: 0.06, h: 0.7, z: 1, config: { type: "brand-logo" }, style: { textAlign: "left", vAlign: "middle" } },
    { id: uid(), x: 0.07, y: 0, w: 0.4, h: 1, z: 2, config: { type: "text", text: "Stage Utility" }, style: { fontSize: 0.022, fontWeight: 600, color: FG, textAlign: "left", vAlign: "middle" } },
    { id: uid(), x: 0.35, y: 0, w: 0.4, h: 1, z: 3, config: { type: "text", text: "WEEKEND" }, style: { fontSize: 0.02, fontWeight: 500, color: FG_MUTED, letterSpacing: 0.04, textAlign: "center", vAlign: "middle" } },
    { id: uid(), x: 0.86, y: 0, w: 0.14, h: 1, z: 4, config: { type: "text", text: "LIVE" }, style: { fontSize: 0.02, fontWeight: 600, color: GREEN, uppercase: true, letterSpacing: 0.07, textAlign: "right", vAlign: "middle" } },
  ]);

  // ── LEFT: CURRENT hero (~60% width) ─────────────────────────────────────────
  const hero = obj(0.02, 0.115, 0.6, 0.87, { type: "container" }, {
    background: "rgba(70,196,126,0.06)", borderColor: "rgba(70,196,126,0.32)", borderWidth: 0.0012, cornerRadius: 0.018, padding: 0.02,
  }, [
    { id: uid(), x: 0.04, y: 0.06, w: 0.9, h: 0.06, z: 1, config: { type: "text", text: "Current" }, style: eyebrow() },
    { id: uid(), x: 0.04, y: 0.13, w: 0.92, h: 0.12, z: 2, config: { type: "current-service-item" }, style: { fontSize: 0.042, fontWeight: 500, color: FG, textAlign: "left", vAlign: "middle" } },
    // Huge Plex Mono countdown, on-pace green (Plex is inherited from the app).
    { id: uid(), x: 0.04, y: 0.3, w: 0.92, h: 0.42, z: 3, config: { type: "countdown-timer" }, style: { fontSize: 0.22, fontWeight: 500, color: GREEN, textAlign: "left", vAlign: "middle" } },
    { id: uid(), x: 0.04, y: 0.73, w: 0.9, h: 0.05, z: 4, config: { type: "text", text: "Remaining" }, style: eyebrow(FG_MUTED) },
    // Service-progress bar (color drives the fill).
    { id: uid(), x: 0.04, y: 0.83, w: 0.92, h: 0.06, z: 5, config: { type: "slide-progress", display: "bar", showLabel: false }, style: { color: GREEN, vAlign: "middle" } },
  ]);

  // ── RIGHT rail: NEXT card + 2×2 tiles ───────────────────────────────────────
  const railX = 0.64, railW = 0.34;
  const next = obj(railX, 0.115, railW, 0.2, { type: "container" }, { ...glass, padding: 0.014 }, [
    { id: uid(), x: 0.06, y: 0.12, w: 0.9, h: 0.22, z: 1, config: { type: "text", text: "Next" }, style: eyebrow() },
    { id: uid(), x: 0.06, y: 0.4, w: 0.9, h: 0.5, z: 2, config: { type: "next-service-item" }, style: { fontSize: 0.03, fontWeight: 500, color: FG, textAlign: "left", vAlign: "middle" } },
  ]);

  // 2×2 tile grid under the NEXT card.
  const tileTop = 0.335, gridBottom = 0.985, gap = 0.014;
  const tileW = (railW - gap) / 2;
  const rowH = (gridBottom - tileTop - gap) / 2;
  const cx1 = railX, cx2 = railX + tileW + gap;
  const ry1 = tileTop, ry2 = tileTop + rowH + gap;
  const tile = (x: number, y: number, label: string, content: LayoutObject): LayoutObject =>
    obj(x, y, tileW, rowH, { type: "container" }, { ...glass, padding: 0.012 }, [
      { id: uid(), x: 0.08, y: 0.14, w: 0.84, h: 0.24, z: 1, config: { type: "text", text: label }, style: eyebrow() },
      content,
    ]);
  const bigVal = (config: LayoutObjectConfig, color = FG): LayoutObject => ({
    id: uid(), x: 0.08, y: 0.42, w: 0.84, h: 0.5, z: 2, config, style: { fontSize: 0.058, fontWeight: 500, color, textAlign: "left", vAlign: "middle" },
  });
  const tiles = [
    tile(cx1, ry1, "Clock", bigVal({ type: "clock", showSeconds: false, format: "12h" })),
    tile(cx2, ry1, "SPL", bigVal({ type: "spl-meter", meterId: null, metricKey: null, showLabel: false, thresholds: null }, ACCENT)),
    tile(cx1, ry2, "Slides left", bigVal({ type: "slide-progress", display: "remaining", showLabel: false })),
    tile(cx2, ry2, "Attendance", bigVal({ type: "people-counter", metric: "attendance", zoneId: null, label: "Attendance", showLabel: false })),
  ];

  return [bar, hero, next, ...tiles];
}


// Canvas aspect presets. Resolution is irrelevant (the renderer scales the design
// canvas to fit any screen, incl. 4K) — only the aspect/orientation matters.
export const CANVAS_PRESETS: { id: string; label: string; w: number; h: number }[] = [
  { id: "16:9", label: "Landscape · 16:9", w: 1920, h: 1080 },
  { id: "9:16", label: "Portrait · 9:16", w: 1080, h: 1920 },
  { id: "4:3", label: "Standard · 4:3", w: 1440, h: 1080 },
  { id: "16:10", label: "Widescreen · 16:10", w: 1920, h: 1200 },
  { id: "21:9", label: "Ultrawide · 21:9", w: 2560, h: 1080 },
  { id: "32:9", label: "Super ultrawide · 32:9", w: 3840, h: 1080 },
  { id: "1:1", label: "Square · 1:1", w: 1080, h: 1080 },
  { id: "3:2", label: "3:2", w: 1620, h: 1080 },
  { id: "5:4", label: "5:4", w: 1350, h: 1080 },
];







// Recursive visual render for the editor canvas. Mirrors the renderer's
// RenderObject but DIMS hidden objects (by their own flag only) instead of
// removing them, so the editor still shows hidden layers faintly.
