// signage-resolve.ts — what every signage screen plays for the next 24 hours.
//
// PURE, and it returns the whole per-output map in one call. That is what lets
// `GET /api/signage/now` and the SSE push be the same answer rather than two
// implementations that can disagree about what a wall is showing.
//
// Resolution is per OUTPUT, not per group, because an output can belong to
// several groups whose schedules disagree. The schedule LIST ORDER settles that,
// and nothing else does — no priority number, no specificity rule — so an
// operator can predict the answer by reading the list top to bottom.

import type {
  Output,
  PcoWindow,
  SignageGroup,
  SignageHorizon,
  SignageHorizonEntry,
  SignageMedia,
  SignageOverride,
  SignagePlaylist,
  SignageReason,
  SignageSchedule,
} from "../types/stage.js";
import type { TimeZone } from "./app-timezone.js";
import { resolveItemDurations } from "./signage-playlist-items.js";
import { nextBoundaryAfter, windowActiveAt } from "./signage-window.js";

export interface ResolveInput {
  now: number;
  tz: TimeZone;
  outputs: Output[];
  groups: SignageGroup[];
  /** ORDERED. The index is the priority. */
  schedules: SignageSchedule[];
  playlists: SignagePlaylist[];
  media: SignageMedia[];
  overrides: SignageOverride[];
  pcoWindows: PcoWindow[];
  liveServiceTypeId: string | null;
}

/** How far ahead a horizon reaches. Long enough that a display can carry itself
 *  through a whole day without the server, short enough to stay small. */
export const HORIZON_MS = 24 * 3600_000;

/** A ceiling on entries, so a pathological schedule set cannot loop or produce a
 *  horizon too big to push. Reaching it is a bug, not a configuration. */
const MAX_ENTRIES = 200;

/** What plays, decided for one instant. Null playlist means blank. */
interface Decision {
  playlist: SignagePlaylist | null;
  reason: SignageReason;
  reasonLabel: string;
}

const BLANK: Decision = { playlist: null, reason: "blank", reasonLabel: "" };

export function resolveSignage(input: ResolveInput): Record<string, SignageHorizon> {
  const byId = new Map(input.playlists.map((p) => [p.id, p]));

  /** A playlist that can actually play, or null. Both "does not exist" and
   *  "nothing in it can play" fall through to the next precedence step rather
   *  than putting an unplayable entry on a wall. */
  const playable = (id: string | null | undefined): SignagePlaylist | null => {
    if (!id) return null;
    const p = byId.get(id);
    if (!p) return null;
    return resolveItemDurations(p, input.media).length > 0 ? p : null;
  };

  const ctx = { pcoWindows: input.pcoWindows, liveServiceTypeId: input.liveServiceTypeId };

  /** Precedence, for one output at one instant. See the spec's section 3.1. */
  const decide = (outputId: string, at: number): Decision => {
    const groups = input.groups.filter((g) => g.outputIds.includes(outputId));
    const groupIds = new Set(groups.map((g) => g.id));

    // 1. Override — the most recently started, which is "the last thing you
    //    pressed" and the only rule an operator under pressure can predict.
    const mine = input.overrides
      .filter((o) => groupIds.has(o.groupId))
      .sort((a, b) => b.startedAt - a.startedAt);
    for (const o of mine) {
      if (o.blank) return { playlist: null, reason: "override", reasonLabel: "Take-over" };
      const p = playable(o.playlistId);
      if (p) return { playlist: p, reason: "override", reasonLabel: p.name };
      // An override naming a deleted playlist falls through rather than blanking
      // a wall because somebody tidied up.
    }

    // 2. Schedules, in list order.
    for (const s of input.schedules) {
      if (!s.enabled) continue;
      if (!s.groupIds.some((id) => groupIds.has(id))) continue;
      if (!windowActiveAt(s.window, at, input.tz, ctx)) continue;
      const p = playable(s.playlistId);
      if (p) return { playlist: p, reason: "schedule", reasonLabel: s.name };
    }

    // 3. The first group that names a usable default.
    for (const g of groups) {
      const p = playable(g.defaultPlaylistId);
      if (p) return { playlist: p, reason: "default", reasonLabel: p.name };
    }

    // 4. Blank.
    return BLANK;
  };

  /** Every instant inside the horizon at which any answer could change. */
  const boundaries = (from: number, to: number): number[] => {
    const set = new Set<number>();
    for (const s of input.schedules) {
      if (!s.enabled) continue;
      let cursor = from;
      // Bounded by MAX_ENTRIES so a window that reports a boundary it has
      // already passed cannot spin here.
      for (let i = 0; i < MAX_ENTRIES; i++) {
        const b = nextBoundaryAfter(s.window, cursor, input.tz, ctx);
        if (b === null || b >= to) break;
        set.add(b);
        cursor = b;
      }
    }
    return [...set].sort((a, b) => a - b);
  };

  const end = input.now + HORIZON_MS;
  const edges = boundaries(input.now, end);
  const out: Record<string, SignageHorizon> = {};

  for (const output of input.outputs) {
    const horizon: SignageHorizon = [];
    let from = input.now;

    // Walk the boundaries, merging neighbours that decided the same thing — a
    // boundary belonging to a schedule that is not winning changes nothing for
    // this output, and splitting there would make the horizon noisier without
    // changing what plays.
    for (const edge of [...edges, end]) {
      if (edge <= from) continue;
      const d = decide(output.id, from);
      const previous = horizon[horizon.length - 1];
      if (
        previous &&
        previous.reason === d.reason &&
        previous.reasonLabel === d.reasonLabel &&
        previous.playlist?.id === d.playlist?.id
      ) {
        previous.until = edge;
      } else {
        horizon.push(entry(from, edge, d, input.media));
      }
      from = edge;
      if (horizon.length >= MAX_ENTRIES) break;
    }

    // An output in no group still gets a horizon. An absent one is
    // indistinguishable, at the display, from a server that has not answered.
    if (horizon.length === 0) horizon.push(entry(input.now, end, BLANK, input.media));
    out[output.id] = horizon;
  }

  return out;
}

function entry(
  from: number,
  until: number,
  d: Decision,
  media: SignageMedia[],
): SignageHorizonEntry {
  if (!d.playlist) {
    return { from, until, reason: d.reason, reasonLabel: d.reasonLabel };
  }
  const items = resolveItemDurations(d.playlist, media);
  return {
    from,
    until,
    reason: d.reason,
    reasonLabel: d.reasonLabel,
    playlist: {
      id: d.playlist.id,
      // The entry's own start. Deterministic, so an identical input gives an
      // identical output and an unrelated config edit does not restart the loop
      // on every wall in the building.
      startedAt: from,
      fit: d.playlist.fit,
      transition: d.playlist.transition,
      items: items.map((r) => ({
        url: `/signage-media/${r.media.file}`,
        mime: r.media.mime,
        durationMs: r.durationMs,
        fit: r.fit,
        transition: r.transition,
        bytes: r.media.bytes,
      })),
    },
  };
}
