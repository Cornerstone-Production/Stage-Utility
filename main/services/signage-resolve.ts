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
import { resolveItemDurations, toHorizonItems } from "./signage-playlist-items.js";
import { tagDefault } from "./signage-defaults.js";
import { migrateGroupDefaults } from "./signage-playlists-store.js";
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

/**
 * The grid the horizon's END is snapped to.
 *
 * The end is an artifact of how far ahead we compute, not an instant anything
 * happens at. Left as `now + HORIZON_MS` it moved with the clock, so the safety
 * tick produced a map that differed from the last one every time and
 * `shouldBroadcast` said "changed" once a minute, forever — every screen
 * receiving the whole plan, rewriting it to the SD card and re-requesting every
 * asset, with nothing edited. Snapped to a grid it is byte-identical between
 * ticks, and only moves when it genuinely rolls over.
 */
export const HORIZON_QUANTUM_MS = HORIZON_MS;

/** A ceiling on entries, so a pathological schedule set cannot loop or produce a
 *  horizon too big to push. Reaching it is a bug, not a configuration. */
const MAX_ENTRIES = 200;

/** What plays, decided for one instant. Null playlist means blank. */
interface Decision {
  playlist: SignagePlaylist | null;
  reason: SignageReason;
  reasonLabel: string;
  /** The schedule / group that decided this. See SignageHorizonEntry.reasonId. */
  reasonId?: string;
}

const BLANK: Decision = { playlist: null, reason: "blank", reasonLabel: "" };

export function resolveSignage(input: ResolveInput): Record<string, SignageHorizon> {
  // A group's old defaultPlaylistId becomes a tag on the playlist it named.
  // Applied HERE rather than by the caller: this function is what every screen's
  // content comes from, and a caller that forgot would silently drop an
  // operator's default with no error anywhere.
  const playlists = migrateGroupDefaults(input.playlists, input.groups);
  const byId = new Map(playlists.map((p) => [p.id, p]));
  // Built ONCE, and BEFORE `playable` closes over it. resolveItemDurations is
  // called up to a couple of hundred times per recompute and used to index the
  // whole library on every call.
  const mediaById = new Map(input.media.map((m) => [m.id, m]));

  /** A playlist that can actually play, or null. Both "does not exist" and
   *  "nothing in it can play" fall through to the next precedence step rather
   *  than putting an unplayable entry on a wall. */
  // MEMOISED for the life of this resolve. The answer cannot change while a
  // single recompute runs, and this is asked once per override, once per
  // matching schedule and once per default claimant, for every output, at every
  // horizon edge — each ask walking the playlist's items.
  const playableCache = new Map<string, SignagePlaylist | null>();
  const playable = (id: string | null | undefined): SignagePlaylist | null => {
    if (!id) return null;
    const cached = playableCache.get(id);
    if (cached !== undefined) return cached;
    const p = byId.get(id);
    const answer = p && resolveItemDurations(p, mediaById).length > 0 ? p : null;
    playableCache.set(id, answer);
    return answer;
  };

  const ctx = { pcoWindows: input.pcoWindows, liveServiceTypeId: input.liveServiceTypeId };

  // A stored record whose list is missing or not a list is SKIPPED, here, once.
  //
  // Reaching into it instead threw inside the scheduler's catch, and the horizon
  // then froze at its last good value for every screen in the building until a
  // restart — a stale wall and one line in the log. The routes refuse such a
  // record now, but a store can already hold one from a hand edit, an older
  // build or a restored snapshot, so the resolver cannot assume the shape.
  const groupsWithOutputs = input.groups.filter((g) => Array.isArray(g.outputIds));
  const schedulesWithGroups = input.schedules.filter((s) => Array.isArray(s.groupIds));

  /** The groups an output belongs to, in list order. */
  const groupsFor = (outputId: string) =>
    groupsWithOutputs.filter((g) => g.outputIds.includes(outputId));

  /**
   * Step 3 of the precedence: the fallback playlist for the tags this output
   * carries.
   *
   * Walks PLAYLISTS in list order, not groups, and that ordering is the entire
   * tie-break: several playlists may declare themselves the default for one tag
   * — a weekend loop and a youth loop on the same foyer screens is a real thing
   * an operator wants — and the first of them wins. Order is something they can
   * see and change; anything else would be a rule they have to be told.
   *
   * Its own function because the trailing default entry needs exactly this step
   * and nothing else. Written twice, the two drifted apart at the first change,
   * and the symptom would be a screen that boots offline to something other than
   * what it shows when the server is up.
   */
  const groupDefault = (groups: SignageGroup[]): Decision => {
    // The rule itself is in signage-defaults, shared with the delete blocker and
    // the offline-assets route. Both of those used to ask the GROUP for its
    // default - a field nothing writes any more - and both were silently wrong.
    //
    // The playability filter stays here because only the resolver has one: an
    // unplayable default falls through to the next claimant rather than blanking
    // the screen, exactly as an unplayable schedule does.
    const won = tagDefault(playlists, new Set(groups.map((g) => g.id)), (c) => !!playable(c.id));
    if (!won) return BLANK;
    const p = playable(won.playlist.id);
    if (!p) return BLANK;
    return { playlist: p, reason: "default", reasonLabel: p.name, reasonId: won.tagId };
  };

  /** Precedence, for one output at one instant. See the spec's section 3.1. */
  const decide = (outputId: string, at: number): Decision => {
    const groups = groupsFor(outputId);
    const groupIds = new Set(groups.map((g) => g.id));

    // 1. Override — the most recently started, which is "the last thing you
    //    pressed" and the only rule an operator under pressure can predict.
    const mine = input.overrides
      .filter((o) => groupIds.has(o.groupId))
      .sort((a, b) => b.startedAt - a.startedAt);
    for (const o of mine) {
      if (o.blank) return { playlist: null, reason: "override", reasonLabel: "Take-over", reasonId: o.groupId };
      const p = playable(o.playlistId);
      if (p) return { playlist: p, reason: "override", reasonLabel: p.name, reasonId: o.groupId };
      // An override naming a deleted playlist falls through rather than blanking
      // a wall because somebody tidied up.
    }

    // 2. Schedules, in list order.
    for (const s of schedulesWithGroups) {
      if (!s.enabled) continue;
      if (!s.groupIds.some((id) => groupIds.has(id))) continue;
      if (!windowActiveAt(s.window, at, input.tz, ctx)) continue;
      const p = playable(s.playlistId);
      if (p) return { playlist: p, reason: "schedule", reasonLabel: s.name, reasonId: s.id };
    }

    // 3. The first group that names a usable default. 4. Blank.
    return groupDefault(groups);
  };

  /** Every instant inside the horizon at which any answer could change. */
  const boundaries = (from: number, to: number): number[] => {
    const set = new Set<number>();
    for (const s of schedulesWithGroups) {
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

  const end = Math.ceil((input.now + HORIZON_MS) / HORIZON_QUANTUM_MS) * HORIZON_QUANTUM_MS;
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
        previous.reasonId === d.reasonId &&
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

    // The group's DEFAULT playlist, appended as a trailing entry covering the
    // day AFTER the horizon.
    //
    // It has to be in here somewhere, because a display that boots with no
    // server plays the default and has nothing but this persisted horizon to
    // find it in — and the default otherwise appears only if it happens to be
    // winning at some point in the next 24 hours. A screen whose schedule
    // covers the whole day would have booted to black.
    //
    // A trailing entry rather than a separate field so the horizon stays one
    // list. It is unreachable in normal play: while connected the horizon is
    // refreshed long before the clock gets there, and while disconnected the
    // display holds rather than advancing (see signage-hold.ts).
    const fallback = groupDefault(groupsFor(output.id));
    if (fallback.playlist) {
      // No end, rather than `end + HORIZON_MS`: this entry is unreachable in
      // normal play, so its upper bound is not a fact about anything — and a
      // bound derived from the clock moved on every tick. The Now board already
      // reads MAX_SAFE_INTEGER as "no end".
      horizon.push(entry(end, Number.MAX_SAFE_INTEGER, fallback, input.media));
    }

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
    return { from, until, reason: d.reason, reasonLabel: d.reasonLabel, ...(d.reasonId ? { reasonId: d.reasonId } : {}) };
  }
  const items = resolveItemDurations(d.playlist, media);
  return {
    from,
    until,
    reason: d.reason,
    reasonLabel: d.reasonLabel,
    ...(d.reasonId ? { reasonId: d.reasonId } : {}),
    playlist: {
      id: d.playlist.id,
      // The entry's own start. Deterministic, so an identical input gives an
      // identical output and an unrelated config edit does not restart the loop
      // on every wall in the building.
      startedAt: from,
      fit: d.playlist.fit,
      transition: d.playlist.transition,
      items: toHorizonItems(items),
    },
  };
}
