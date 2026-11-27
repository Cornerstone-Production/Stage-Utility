// Auto mode holding the followed plan past its planned end, because Planning Center
// still reports it live.
//
// Nothing time-based moves off a live service (CLAUDE.md, "Time"), so a plan left
// live with no SERVICE END header, or Live left on its last item, is followed until
// Planning Center says it has ended. The server decides that it is holding and says so
// in StageState; this only words it, with the way to pick another plan.

import { attentionKey, type AttentionInput, type AttentionItem, type AttentionSource } from "../types";

/** "25 min", "1 h 35 min", "3 h". */
function pastText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export const rolloverHeld: AttentionSource = {
  id: "rollover-held",
  items(input: AttentionInput): AttentionItem[] {
    // A server older than the field says nothing, and nothing is listed. A hold left
    // from a plan since changed is not this plan's.
    const held = input.state.rolloverHeld;
    if (!held || held.planId !== input.state.planId) return [];
    const ends = Date.parse(held.endsAt);
    const name = held.planTitle ?? "the last plan";
    const when = held.planDates ? ` (${held.planDates})` : "";
    return [
      {
        key: attentionKey("rollover-held", held.planId),
        severity: "warn",
        title: `Still following ${name}${when}`,
        detail: `Planning Center says it is live${Number.isFinite(ends) ? `, ${pastText(input.now - ends)} past its planned end` : ""} · auto mode moves on when it ends`,
        fix: { label: "Pick a plan", route: "/plan", flash: "plan-selection" },
      },
    ];
  },
};
