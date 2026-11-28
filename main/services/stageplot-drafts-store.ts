// stageplot-drafts-store.ts — the plot editor's kept drafts (stageplot-drafts.json): what
// is drawn on a plot and not saved yet, one draft per plot, so a reload, a closed tab or a
// crash does not lose it.
//
// A draft is not the plot. It never touches stageplots.json, is never on /stageplots or
// the public page, and is never published; Save sends the items and deletes the draft. It
// is the operator's work, so a config backup carries it ("config"). Its own file, so the
// editor storing a draft every second never rewrites, broadcasts or republishes the plots.
// See docs/features/stageplots.md#save-and-discard.

import { STAGEPLOT_LIMITS, type PlotDraft } from "../types/stageplots.js";
import { DataStore } from "./data-store.js";
import { asArray, asObject, checked, refuse } from "./restore-check.js";
import { STAGEPLOT_ID, checkItems, isoInstant } from "./stageplots-store.js";

export interface PlotDraftsDoc {
  /** Sorted by plotId, one per plot. */
  drafts: PlotDraft[];
}

const EMPTY: PlotDraftsDoc = { drafts: [] };

/** One draft for every plot there can be. */
export const MAX_DRAFTS = STAGEPLOT_LIMITS.venues * STAGEPLOT_LIMITS.plotsPerVenue;

/**
 * The height a draft's items are held to on a restore, where the plot they belong to is in
 * another file: none is refused for its height there. A draft is held to its plot's height
 * when it is stored, and the editor fits it to the plot's height when it opens it.
 */
const ANY_HEIGHT = Number.MAX_VALUE;

function checkDraft(raw: unknown, i: number): PlotDraft {
  const d = asObject(raw, `draft ${i + 1}`);
  if (typeof d.plotId !== "string" || !STAGEPLOT_ID.test(d.plotId)) refuse(`draft ${i + 1}'s plot id must be 1 to 80 letters, digits, - or _`);
  const what = `the draft for plot "${d.plotId}"`;
  if (typeof d.baseVersion !== "number" || !Number.isInteger(d.baseVersion) || d.baseVersion < 0) refuse(`${what}'s base version must be a whole number`);
  return { plotId: d.plotId, baseVersion: d.baseVersion, items: checkItems(d.items, ANY_HEIGHT, what), savedAt: isoInstant(d.savedAt, `${what}'s time`) };
}

/** The whole file, each draft rebuilt, at most one per plot, sorted: the restore check and the rule every write keeps. */
export function checkDraftsDoc(raw: unknown): PlotDraftsDoc {
  const doc = asObject(raw, "the plot drafts");
  const drafts = asArray(doc.drafts, "the plot drafts").map(checkDraft);
  if (drafts.length > MAX_DRAFTS) refuse(`there can be at most ${MAX_DRAFTS} plot drafts`);
  const seen = new Set<string>();
  for (const d of drafts) {
    if (seen.has(d.plotId)) refuse(`plot "${d.plotId}" has more than one draft`);
    seen.add(d.plotId);
  }
  return { drafts: drafts.sort((a, b) => a.plotId.localeCompare(b.plotId)) };
}

const store = new DataStore<PlotDraftsDoc>("stageplot-drafts.json", EMPTY, "config", { restoreCheck: checked(checkDraftsDoc) });

export const plotDraftsStore = {
  /** Every draft. Throws a StoreReadError (503) when the file cannot be read, rather than answering none. */
  async all(): Promise<PlotDraft[]> {
    return (await store.loadStrict()).drafts;
  },
  /**
   * Read-modify-write, serialized against every other write and held to checkDraftsDoc. A
   * mutator that returns its input writes nothing. Resolves to the drafts as saved.
   */
  async update(fn: (drafts: PlotDraft[]) => PlotDraft[]): Promise<PlotDraft[]> {
    const saved = await store.update((doc) => {
      const next = fn(doc.drafts);
      return next === doc.drafts ? doc : checkDraftsDoc({ drafts: next });
    });
    return saved.drafts;
  },
};
