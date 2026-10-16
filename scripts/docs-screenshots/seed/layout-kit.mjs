// seed/layout-kit.mjs — small helpers for writing layout JSON by hand.
//
// Positions are fractions of the canvas (or of the parent container); font sizes
// are fractions of canvas height. See docs/reference/layout-editor.md.

let counter = 0;

/** A layout object. `box` is [x, y, w, h]. */
export function obj(config, box, { style, id, z, children, extra } = {}) {
  counter += 1;
  const [x, y, w, h] = box;
  return {
    id: id ?? `docs-${config.type}-${counter}`,
    x,
    y,
    w,
    h,
    z: z ?? counter,
    config,
    ...(style ? { style } : {}),
    ...(children ? { children } : {}),
    ...(extra ?? {}),
  };
}

/** The card look the built-in dashboards use, in one dark theme for walls. */
export const CARD = {
  background: "#16181b",
  cornerRadius: 0.012,
  borderColor: "#2a2e33",
  borderWidth: 0.001,
  color: "#e8eaed",
};

export function layout(objects, { width = 1920, height = 1080, background = "#0c0d0f", fit = "contain" } = {}) {
  return { version: 1, canvas: { width, height, background, fit }, objects };
}
