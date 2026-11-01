// Which Home cards open over the page, and what they open to.
//
// A Record keyed by the card types, so the type checker owns the set: a card
// listed in `ExpandableHomeCard` and missing from `EXPANDED_BODIES` (or the
// reverse) does not compile. expanded-registry.test.ts holds the same set as an
// exact sorted list, so adding a card is a visible line in a diff.
//
// A card NOT in here is untouched: it draws exactly what it drew and links
// exactly where it linked.

import type { ComponentType } from "react";

import type { LayoutObject, LayoutObjectConfig } from "@main/types/views";

import { readTimerConfig, timerSource } from "../../../main/timer-config";
import { AttendanceBody, RundownBody, ScreensBody, WirelessBody, type BodyProps } from "./bodies";

/** Every layout type that can expand. Checked against the real config union. */
export type ExpandableHomeCard = Extract<
  LayoutObjectConfig["type"],
  "current-service-item" | "home-recent-services" | "home-screens" | "timer" | "wireless-summary"
>;

export interface ExpandedBody {
  /** The overlay's title: the card's own name. */
  name: string;
  /** Where the card led before it expanded. Always offered in the panel's
   *  header, so nothing lost its way to its page by gaining a panel. */
  page: { to: string; label: string };
  /** Whether a press on the card body expands, and not only the corner control.
   *  True only where the card holds no controls of its own: a press on a card
   *  with a button in it must be the button's. */
  bodyPress: boolean;
  Body: ComponentType<BodyProps>;
}

export const EXPANDED_BODIES: Record<ExpandableHomeCard, ExpandedBody> = {
  "wireless-summary": {
    name: "Wireless",
    page: { to: "/mic-slots", label: "Open Mic slots" },
    bodyPress: true,
    Body: WirelessBody,
  },
  "home-screens": {
    name: "Screens",
    page: { to: "/screens", label: "Open Screens" },
    bodyPress: true,
    Body: ScreensBody,
  },
  timer: {
    name: "Service order",
    page: { to: "/plan", label: "Open Plan" },
    bodyPress: false,
    Body: RundownBody,
  },
  "current-service-item": {
    name: "Service order",
    page: { to: "/plan", label: "Open Plan" },
    bodyPress: false,
    Body: RundownBody,
  },
  "home-recent-services": {
    name: "Recent services",
    page: { to: "/history/manage", label: "Open History" },
    bodyPress: true,
    Body: AttendanceBody,
  },
};

/**
 * The expanded body a card has, or null for a card that links as it always did.
 *
 * A Timer expands only when it reads the SERVICE: its rundown is the service's,
 * and a ProPresenter or baptism timer opening to a plan would be the wrong
 * answer to a press.
 */
export function expandedBodyFor(o: LayoutObject): ExpandedBody | null {
  const timer = readTimerConfig(o.config);
  if (timer) return timerSource(timer) === "service" ? EXPANDED_BODIES.timer : null;
  return Object.hasOwn(EXPANDED_BODIES, o.config.type) ? EXPANDED_BODIES[o.config.type as ExpandableHomeCard] : null;
}
