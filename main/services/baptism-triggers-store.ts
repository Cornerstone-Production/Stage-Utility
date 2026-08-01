// Which plan items start the baptism timer's two phases.
//
// The two triggers need different mechanisms, because they differ in how stable
// they are week to week:
//
//   testimonies  a plan item named the same every time ("BAPTISM STORIES"), so a
//                keyword finds it with no weekly setup
//   baptisms     whichever song the baptisms happen during, which changes every
//                week — no keyword can ever find it, so it is picked per plan
//
// Bindings are stored against the plan id, so setting them on Saturday holds
// through Sunday. Plans that were never bound simply have no entry, and the timer
// stays manual for them, which is every ordinary weekend.

import type { BaptismTriggers } from "../types/stage.js";
import { DataStore } from "./data-store.js";

/** planId → which items start each phase. */
type File = Record<string, BaptismTriggers>;

const store = new DataStore<File>("baptism-triggers.json", {});

export const baptismTriggersStore = {
  async all(): Promise<File> {
    const raw = await store.load();
    return raw && typeof raw === "object" ? raw : {};
  },

  async get(planId: string | null | undefined): Promise<BaptismTriggers | null> {
    if (!planId) return null;
    return (await this.all())[planId] ?? null;
  },

  async set(planId: string, triggers: BaptismTriggers): Promise<void> {
    const all = await this.all();
    // An entry with neither trigger set is the same as none — drop it rather than
    // accumulating an entry for every plan the panel was merely opened on.
    if (!triggers.testimonyItemId && !triggers.baptismItemId) delete all[planId];
    else all[planId] = triggers;
    await store.save(all);
  },
};
