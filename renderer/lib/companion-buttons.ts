// companion-buttons.ts — the one read of `GET /api/companion/buttons`.
//
// The button picker and Browse buttons both read it, so they share a query key and a
// cache: opening one after the other costs no second read of Companion's export.

import type { CompanionPageSummary } from "@main/services/companion-export";

import type { CompanionButton } from "../settings/sections/companion-cues";
import { invoke } from "./api";

/** What the route answers: every pressable button and the page list, or why Companion could not be read. */
export interface CompanionButtonsReply {
  ok: boolean;
  reason?: string;
  buttons: CompanionButton[];
  /** Every page, with how many labelled buttons it holds (0 is an empty page). Absent from an older server. */
  pages?: CompanionPageSummary[];
}

export const companionButtonsQuery = {
  queryKey: ["companion:buttons"],
  queryFn: () => invoke<CompanionButtonsReply>("companion:buttons"),
} as const;
