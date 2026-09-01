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

/**
 * Output ids with a live heartbeat. Empty means "none, or we do not know" — the
 * safe direction: a dot that is dark invites a look at the screen, a dot that is
 * lit says there is nothing to look at.
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
 */
export function useDisplayPresence(enabled = true): readonly string[] {
  const read = useCallback(() => invoke<PresenceDTO>("displays:getPresence"), []);
  const presence = useStatusChannel<PresenceDTO>(read, "displays:presence", enabled, {
    clearOnReadFailure: true,
  });
  return enabled ? (presence?.connected ?? EMPTY) : EMPTY;
}
