// scores-store.ts — which teams the operator follows.
//
// "config": these are the operator's choices, and losing them to a reinstall is
// losing their setup. Being config is also what puts the file in every backup —
// the allowlist is derived from this classification, so a store misfiled as
// "runtime" is silently missing from every snapshot with the suite green.
//
// GLOBAL, not per-device, like bar-config: two operators on two machines should
// be following the same teams.

import { broadcast } from "./broadcaster.js";
import { DataStore } from "./data-store.js";
import { asArray, asObject, checked } from "./restore-check.js";
import { leagueById, type ScoreFavourite, type ScoresConfig } from "../types/scores.js";

const DEFAULT: ScoresConfig = { favourites: [] };

/** keepKnownFavourites drops what it cannot use rather than refusing it, on a
 *  save and here alike, so a backup from a build with a league this one lacks
 *  still restores. */
const restoreCheck = checked((raw) => {
  const file = asObject(raw, "the followed teams");
  return { ...file, favourites: keepKnownFavourites(asArray(file.favourites, "the followed teams' favourites")) };
});

/**
 * Only the entries naming a team id and a league this build knows. A favourite
 * for a league that no longer exists would make every poll ask for a path ESPN
 * does not serve. Used by POST /api/scores/favourites and a restore.
 */
export function keepKnownFavourites(list: readonly unknown[]): ScoreFavourite[] {
  return list.filter(
    (f): f is ScoreFavourite =>
      typeof f === "object" && f !== null && typeof (f as ScoreFavourite).teamId === "string" &&
      (f as ScoreFavourite).teamId !== "" && leagueById((f as ScoreFavourite).league) !== null,
  );
}

const store = new DataStore<ScoresConfig>("scores-favourites.json", DEFAULT, "config", { restoreCheck });

let cache: ScoresConfig = DEFAULT;

export const scoresStore = {
  async init(): Promise<void> {
    cache = await store.load();
  },
  get(): ScoresConfig {
    return cache;
  },
  async setFavourites(favourites: ScoreFavourite[]): Promise<ScoresConfig> {
    cache = await store.update((c) => ({ ...c, favourites }));
    // ANNOUNCED, like the other three lists that are an integration's setup
    // (wireless connections, OSC targets, RossTalk targets). This list was the
    // odd one out: the poller was restarted by an explicit call from the one
    // route that writes it, so a second writer that forgot it would leave scores
    // stopped with the panel reporting teams followed. integration-manager
    // answers this channel; see setupListRefreshers there.
    broadcast("scores:favourites-changed", cache);
    return cache;
  },
};
