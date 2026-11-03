// Each failing readiness check, in the order they should be fixed.
//
// Reuses readinessChecks() whole, so the two widgets cannot disagree about what
// is not ready. Two things differ on purpose:
//
//  - "Screens online" is left out. The screen-offline source says the same thing
//    per screen, with when it was last seen and an Open screen button for the
//    right card; both would list one dropped screen twice.
//  - A check's label reads as a state ("A plan selected"), which is wrong as the
//    title of a problem, so each says what is missing instead.

import { readinessChecks } from "../../readiness";
import { attentionKey, type AttentionInput, type AttentionItem, type AttentionSource } from "../types";

const WORDING: Record<string, { title: string; fix: string }> = {
  pco: { title: "Planning Center is not connected", fix: "Connect" },
  plan: { title: "No plan selected", fix: "Choose a plan" },
  views: { title: "No view of your own yet", fix: "Open screens" },
  assigned: { title: "A screen has no view", fix: "Open screens" },
};

export const readiness: AttentionSource = {
  id: "readiness",
  items(input: AttentionInput): AttentionItem[] {
    // Presence is only consulted by the check dropped below; `true` keeps it
    // from ever reading as "checking".
    return readinessChecks(input.state, input.onlineOutputIds, true)
      .filter((c) => !c.ok && c.id !== "online")
      .map((c) => ({
        key: attentionKey("readiness", c.id),
        severity: "warn" as const,
        title: c.id === "assigned" && !input.state.outputs?.length ? "No screens set up yet" : (WORDING[c.id]?.title ?? c.label),
        detail: c.detail,
        fix: { label: WORDING[c.id]?.fix ?? "Fix", route: c.route, flash: c.flash },
      }));
  },
};
