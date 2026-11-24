// Whether the Theme photos button can be pressed, and if not, why and what to do.
// The reason is said twice: as the button's tooltip, and as a line under the bar,
// because a tooltip needs a hover and a phone has none.
//
// The OpenAI connection is deliberately not a reason. Without a working key the
// sheet still opens: the Original | Themed switch, Approve, Remove and Delete call
// nobody, and an operator whose key lapsed must still be able to take themed
// photos off the screens. Only Generate and Redo wait for a key, in the sheet.

export interface ThemePhotosReason {
  why: string;
  /** What the line under the bar offers: move to the plan. */
  fix: "plan" | null;
}

export function themePhotosReason(input: {
  hasServiceType: boolean;
  hasPlan: boolean;
  /** Which side of the plan the page is editing. */
  side: "default" | "plan";
}): ThemePhotosReason | null {
  if (!input.hasServiceType) return { why: "Pick a service type first", fix: null };
  if (input.side !== "plan" || !input.hasPlan) {
    return { why: "Theme photos is per service: pick a plan", fix: input.hasPlan ? "plan" : null };
  }
  return null;
}
