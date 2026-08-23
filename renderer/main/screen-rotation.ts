// screen-rotation.ts — the transform that makes a portrait TV render portrait.
//
// PURE, so the geometry can be checked without a browser. It is exactly the kind
// of arithmetic that looks right and is off by a half-turn, and the cost of
// getting it wrong is a wall nobody can read until someone walks over with a
// laptop.
//
// The whole surface is rotated, not the content, because rotation is a fact
// about the PANEL: it is mounted that way whatever is playing on it. That means
// at 90 and 270 the box the content lays out in has to swap its width and
// height — a rotated element keeps the dimensions it was given, so a surface
// sized to the viewport and then turned would be laid out landscape and drawn
// sideways off both edges.

import type { CSSProperties } from "react";
import type { ScreenRotation } from "@main/types/views";

/**
 * Styles for the element wrapping everything a screen draws.
 *
 * `100dvh` / `100dvw` rather than `vh`/`vw`: on a browser with dynamic chrome
 * the static units include space that is not actually visible, which puts the
 * bottom of a rotated layout behind a toolbar.
 */
export function rotationStyle(rotation: ScreenRotation): CSSProperties {
  const quarter = isQuarterTurn(rotation);
  // The box's own dimensions, published for the content inside it.
  //
  // Every kiosk root sizes itself `h-[100dvh]`, which resolves against the
  // VIEWPORT and not against this box - so at a quarter turn on a 1920x1080
  // panel the content filled a 1080x1080 square and left 840px of black. Only
  // the signage screen used `h-full`, which is why it was the one case that got
  // driven. They read these instead, with `100dvh` as the fallback so anything
  // not inside a rotated wrapper is unchanged.
  const box = {
    ["--screen-w" as string]: quarter ? "100dvh" : "100dvw",
    ["--screen-h" as string]: quarter ? "100dvw" : "100dvh",
  } as CSSProperties;

  if (rotation === 0) return { ...box, width: "100dvw", height: "100dvh" };

  return {
    ...box,
    // Swapped at a quarter turn: this is the box the CONTENT is laid out in,
    // before the turn puts it on the panel.
    width: quarter ? "100dvh" : "100dvw",
    height: quarter ? "100dvw" : "100dvh",
    transform: `rotate(${rotation}deg)`,
    // Rotate about the centre and then pull the box back over the viewport.
    // Without the absolute placement the turned element still occupies its
    // pre-rotation footprint in flow, which leaves a scrollbar and an offset.
    transformOrigin: "center center",
    position: "absolute",
    top: "50%",
    left: "50%",
    // translate(-50%, -50%) is applied by the parent's own centring below, so
    // this margin form is used instead: `transform` is already spent on the
    // rotation, and a second transform on the same element would compose in the
    // wrong order.
    marginTop: quarter ? "calc(-50dvw)" : "calc(-50dvh)",
    marginLeft: quarter ? "calc(-50dvh)" : "calc(-50dvw)",
  };
}

/** True when the content is laid out in a box whose sides are swapped. */
export function isQuarterTurn(rotation: ScreenRotation): boolean {
  return rotation === 90 || rotation === 270;
}

/** How a screen's own pixel size reads once it is mounted this way — what the
 *  operator should be designing against. */
export function rotatedSize(
  size: { w: number; h: number },
  rotation: ScreenRotation,
): { w: number; h: number } {
  return isQuarterTurn(rotation) ? { w: size.h, h: size.w } : { w: size.w, h: size.h };
}
