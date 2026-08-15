// Which fit a surface uses, as one decision.
//
// A wall screen has a known aspect, so its design is honoured exactly, bars and
// all. A console is on whatever window the operator has, so it responds.

import { viewSurface } from "@main/types/views";

export type Fit = "contain" | "responsive";

/**
 * The fit for a view, given whatever the layout explicitly asked for.
 *
 * An explicit setting ALWAYS wins: a default must never override a choice the
 * operator made deliberately. `"fill"` is the old name and reads as
 * `"responsive"` — nothing in a real config used it, but a stored value must
 * still parse rather than falling through to the wrong default.
 */
export function fitFor(
  view: Pick<View, "surface">,
  explicit: "contain" | "fill" | "responsive" | undefined,
): Fit {
  if (explicit === "contain") return "contain";
  if (explicit === "fill" || explicit === "responsive") return "responsive";
  return viewSurface(view) === "console" ? "responsive" : "contain";
}
