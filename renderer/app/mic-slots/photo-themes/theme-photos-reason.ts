// Whether the Theme photos button can be pressed, and if not, why and what to do.
// The reason is said twice: as the button's tooltip, and as a line under the bar,
// because a tooltip needs a hover and a phone has none.

import type { OpenAiConnectionDTO } from "@main/types/photo-themes";

import { connectionWorks } from "./use-photo-themes";

export interface ThemePhotosReason {
  why: string;
  /** What the line under the bar offers: open Integrations, or move to the plan. */
  fix: "integrations" | "plan" | null;
}

export function themePhotosReason(input: {
  hasServiceType: boolean;
  hasPlan: boolean;
  /** Which side of the plan the page is editing. */
  side: "default" | "plan";
  /** `undefined` while it has not been read: not held against the button. */
  connection: OpenAiConnectionDTO | undefined;
}): ThemePhotosReason | null {
  if (!input.hasServiceType) return { why: "Pick a service type first", fix: null };
  if (input.side !== "plan" || !input.hasPlan) {
    return { why: "Theme photos is per service: pick a plan", fix: input.hasPlan ? "plan" : null };
  }
  if (input.connection && !connectionWorks(input.connection)) return { why: "Connect OpenAI in Integrations", fix: "integrations" };
  return null;
}
