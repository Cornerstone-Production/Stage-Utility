// automation-roster-match.ts — find the one scheduled person carrying a marker.
//
// PURE. Reads ONLY the PCO note on each scheduled member: no slots, no
// slot-resolver, no slots.json. The number an operator types in the note IS the
// slot, and parsing it as a whole token means "10 TB" reads as ten rather than as
// one — the prefix ambiguity slot-resolver still has, inherited by anything that
// reuses it.
//
// Refuses on anything ambiguous, and says why in words an operator can act on:
// the reason is surfaced in the automation log and on the Companion error feedback,
// so "two or more people are marked TB: Jacob, Molly" is the whole diagnosis.
//
// The caller HOLDS the previous value on refusal. A scheduling mistake must never
// take a live route away.

import type { TeamMemberDTO } from "../types/stage.js";

export type RosterMatch =
  | { ok: true; slot: number; member: TeamMemberDTO }
  | { ok: false; reason: string };

/**
 * Whole-word, case-insensitive containment.
 *
 * "TB" must not match "TBD" — that is a scheduling comment, and acting on it would
 * route talkback to whoever happened to be undecided.
 *
 * The boundary is LETTERS only, not letters-and-digits, because digits legitimately
 * abut the marker: "4TB" is one operator's way of writing what another writes as
 * "4 TB", and both mean slot four. Only a letter on either side means the marker is
 * part of a longer word. The marker itself is escaped — an operator types free text
 * here and it must never become a pattern.
 */
function hasMarker(notes: string, marker: string): boolean {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`, "i").test(notes);
}

/** The first standalone integer in the note ("4 TB" and "TB 4" both give 4). */
function slotOf(notes: string): number | null {
  const m = /(^|[^0-9])(\d{1,2})([^0-9]|$)/.exec(notes);
  const n = m ? Number(m[2]) : Number.NaN;
  return Number.isInteger(n) ? n : null;
}

export function matchRoster(
  members: TeamMemberDTO[],
  opts: { marker: string; position?: string },
): RosterMatch {
  const marker = (opts?.marker ?? "").trim();
  // An empty marker would match every note, which is the one outcome that could
  // silently reroute audio. Refuse rather than guess.
  if (!marker) return { ok: false, reason: "no marker configured" };
  const position = (opts?.position ?? "").trim().toLowerCase();

  const hits = (Array.isArray(members) ? members : []).filter((mem) => {
    const notes = (mem?.notes ?? "").trim();
    if (!notes || !hasMarker(notes, marker)) return false;
    if (position && (mem.teamPositionName ?? "").trim().toLowerCase() !== position) return false;
    return true;
  });

  if (hits.length === 0) return { ok: false, reason: `nobody scheduled is marked "${marker}"` };
  if (hits.length > 1) {
    return {
      ok: false,
      reason: `two or more people are marked "${marker}": ${hits.map((h) => h.name).join(", ")}`,
    };
  }

  const only = hits[0];
  const slot = slotOf((only.notes ?? "").trim());
  if (slot === null) {
    return { ok: false, reason: `${only.name} is marked "${marker}" but their note has no number` };
  }
  return { ok: true, slot, member: only };
}
