// Which screens actually have a browser attached.
//
// The server has known this all along: display-presence.ts tracks a heartbeat
// per output with a 90s TTL and a sendBeacon on unload, and broadcasts the
// connected set on "displays:presence" only when it changes. Settings →
// Displays has been lighting a real dot from it.
//
// Home and the multiview tiles used `outputs.filter(o => o.viewId)` instead,
// which is ROUTED, not connected — so a screen that is routed and unplugged read
// as online for ever. On a producer wall that is the worst available lie: the
// one tile you need to notice is the one that looks fine.
//
// `enabled` is how a wall display avoids subscribing to something it does not
// draw, which was the objection that kept the fake in place. Same shape as every
// other gated channel in useLayoutData: `useObsState(want([...]))`.
//
// THE REV-ORDERING RULE IS NOT WRITTEN HERE. It was — the appliedRev ref, the
// fresh-window reset, the drop-strictly-older guard and push-always-wins, a
// third hand-rolled copy of what use-status-channel.ts owns, with comments
// restating that file's header in different words. The two had already come
// apart on a detail (a rev-less read applied via `?? POSITIVE_INFINITY` here and
// via a `typeof === "number"` guard there) on the day they were written.
//
// The one thing that genuinely differed is the failure clear below, which is now
// an option on the shared hook rather than a reason to keep a second copy.

import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

/** Stable identity, so `enabled: false` does not hand a new array out per render. */
const EMPTY: readonly string[] = [];

interface PresenceDTO {
  connected?: string[];
  /** Which broadcast this set belongs to — see display-presence.ts. */
  rev?: number;
}

export interface DisplayPresenceResult {
  onlineOutputIds: readonly string[];
  /** Whether ANY answer has landed yet — see useStatusChannel's own header.
   *  Empty ids while this is false is "we do not know", not "none online":
   *  Home's readiness list and screens count must say so rather than reading
   *  every screen as offline for the width of one slow read. */
  known: boolean;
}

/**
 * Output ids with a live heartbeat, plus whether presence has answered yet.
 *
 * Hydrated as well as subscribed, exactly like useObsState. The SSE hello burst
 * does carry a presence snapshot and api.ts caches it for a late subscriber —
 * but only the CONNECT-time value. Between the burst and this hook mounting, the
 * server filters "displays:presence" out for a client with nothing subscribed to
 * it, so every change in that window is lost and the cached snapshot can be
 * hours old. Presence broadcasts only on change, so in a quiet building nothing
 * would ever correct it. Asking once is what makes the first paint true rather
 * than true-as-of-page-load.
 *
 * clearOnReadFailure, which no other caller sets. Presence is a claim about the
 * PRESENT: on an `enabled` false→true flip the previous set would otherwise
 * persist and render as lit, reporting screens as Connected on the strength of a
 * read that just failed — the exact class of lie this hook exists to remove.
 * `known` still goes true on that failed read: it settled the window, even
 * though the honest reading of "we do not know" it lands on is the same empty
 * set unknown itself renders — the caller judges the two apart by `known`,
 * never by whether the id list happens to be empty.
 */
export function useDisplayPresenceStatus(enabled = true): DisplayPresenceResult {
  const read = useCallback(() => invoke<PresenceDTO>("displays:getPresence"), []);
  const { value: presence, known } = useStatusChannel<PresenceDTO>(read, "displays:presence", enabled, {
    clearOnReadFailure: true,
  });
  return {
    onlineOutputIds: enabled ? (presence?.connected ?? EMPTY) : EMPTY,
    known: enabled ? known : false,
  };
}

/**
 * The ids alone, for a caller that does not judge "none online" against "we do
 * not know" — the custom-layout screen tile, which already draws a screen with
 * no heartbeat as offline whether that is settled or merely not yet known, the
 * same way it would before the very first read of any kind ever lands.
 */
export function useDisplayPresence(enabled = true): readonly string[] {
  return useDisplayPresenceStatus(enabled).onlineOutputIds;
}
