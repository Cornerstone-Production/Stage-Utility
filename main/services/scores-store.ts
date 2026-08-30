// scores-store.ts — which teams the operator follows.
//
// "config": these are the operator's choices, and losing them to a reinstall is
// losing their setup. Being config is also what puts the file in every backup —
// the allowlist is derived from this classification, so a store misfiled as
// "runtime" is silently missing from every snapshot with the suite green.
//
// GLOBAL, not per-device, like bar-config: two operators on two machines should
// be following the same teams.

import { DataStore } from "./data-store.js";
import type { ScoreFavourite, ScoresConfig } from "../types/scores.js";

const DEFAULT: ScoresConfig = { favourites: [] };

const store = new DataStore<ScoresConfig>("scores-favourites.json", DEFAULT, "config");

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
    return cache;
  },
};
