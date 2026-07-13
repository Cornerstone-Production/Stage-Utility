// Persists ScriptView layouts — named column presets per PCO service type for the
// in-app ScriptViewer replacement. A flat list; each layout carries its own
// serviceTypeId, so one store holds every service type's presets.

import type { ScriptViewLayout } from "../types/stage.js";
import { DataStore } from "./data-store.js";

/** Starter layouts seeded on a fresh install (when no store file exists yet).
 *  Generic production-role columns any church can rename/reorder/delete; columns
 *  reference PCO note-category names, so a category a plan lacks renders empty.
 *  All element toggles default shown (show* omitted = shown). */
const DEFAULT_LAYOUTS: ScriptViewLayout[] = [
  { id: "starter-audio", name: "Audio", order: 0, columns: ["Audio", "Band", "MD + Playback Tech", "Vocals"], accentDepartment: "Audio" },
  { id: "starter-video", name: "Video", order: 1, columns: ["Graphics", "Video", "Vocals"], accentDepartment: "Video" },
  { id: "starter-lighting", name: "Lighting", order: 2, columns: ["Lighting", "Band", "Stage Manager"], accentDepartment: "Lighting" },
  { id: "starter-stage", name: "Stage", order: 3, columns: ["Stage Manager"], accentDepartment: "Stage Manager" },
  { id: "starter-simple", name: "Simple", order: 4, columns: [], accentDepartment: null },
];

const store = new DataStore<ScriptViewLayout[]>("scriptview-layouts.json", DEFAULT_LAYOUTS);

export const scriptViewLayoutsStore = {
  async load(): Promise<ScriptViewLayout[]> {
    return store.load();
  },

  async save(layouts: ScriptViewLayout[]): Promise<void> {
    return store.save(layouts);
  },
};
