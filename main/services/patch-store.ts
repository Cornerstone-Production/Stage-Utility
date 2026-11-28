// patch-store.ts — Persists the stage patch sheets. Each sheet (Analog, Dante,
// WSG, Monitoring, …) carries its own devices, default endpoint patch, variants,
// and weekly assignments. Backed by the generic DataStore (patch.json). See
// docs/patch-sheet/DESIGN.md.

import type { PatchFile, PatchSheet, PatchSheetKind } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { errorMessage } from "./errors.js";
import { DataStore, StoreReadError } from "./data-store.js";
import { normalizePatch } from "./patch-shape.js";
import { asArray, asObject, checked } from "./restore-check.js";
import { scrub } from "./scrub.js";

const emptyAssignments = () => ({ byServiceType: {}, byPlan: {} });
function blankSheet(id: string, name: string, kind: PatchSheetKind): PatchSheet {
  return { id, name, kind, devices: [], endpoints: [], variants: [], assignments: emptyAssignments() };
}

// A fresh install ships with the four common patch surfaces; all are renamable /
// removable in the editor.
const seedSheets = (): PatchSheet[] => [
  blankSheet("analog", "Analog", "analog"),
  blankSheet("dante", "Dante", "dante"),
  blankSheet("wsg", "WSG", "network"),
  blankSheet("monitoring", "Monitoring", "monitor"),
];

const EMPTY: PatchFile = { sheets: seedSheets(), updatedAt: "" };

/**
 * Normalize any stored shape into the current multi-sheet PatchFile:
 *  - New shape (`{ sheets }`) → returned as-is.
 *  - Legacy single-patch (`{ devices, endpoints, variants, assignments }`) → its
 *    data becomes the "Analog" sheet, plus the other three seeded — so existing
 *    patches survive the upgrade untouched.
 * DataStore.load() returns the parsed file as-is (no merge), so no data is lost.
 */
function migrate(raw: PatchFile): PatchFile {
  const r = raw as unknown as Record<string, unknown> | null;
  if (r && Array.isArray(r.sheets)) return raw;
  const legacy = (r ?? {}) as Partial<PatchSheet> & { updatedAt?: string };
  const analog: PatchSheet = {
    ...blankSheet("analog", "Analog", "analog"),
    devices: legacy.devices ?? [],
    endpoints: legacy.endpoints ?? [],
    variants: legacy.variants ?? [],
    assignments: legacy.assignments ?? emptyAssignments(),
  };
  return {
    sheets: [analog, blankSheet("dante", "Dante", "dante"), blankSheet("wsg", "WSG", "network"), blankSheet("monitoring", "Monitoring", "monitor")],
    updatedAt: legacy.updatedAt ?? "",
  };
}

/**
 * The patch was saved and announced, but something that follows it (the stage plot points) could
 * not be brought up to date. The message is the whole instruction: saving again retries it.
 */
export class PatchLinksNotUpdated extends Error {
  constructor(cause: unknown) {
    super("The patch was saved, but the stage plot connection points could not be updated to follow it. Saving the patch again retries it.", { cause });
    this.name = "PatchLinksNotUpdated";
  }
}

/**
 * What a saved patch owes others before it is announced. `before` is the files it replaced, oldest
 * first: the one this save replaced, preceded by the ones earlier saves whose followers failed
 * replaced (a retry still stamps the devices those saves removed).
 */
type SavedHook = (before: readonly PatchFile[], after: PatchFile) => Promise<void>;

class PatchStore {
  private savedHooks: SavedHook[] = [];
  /**
   * The patch each save whose follower failed replaced, by the order the saves were stored in, until a later save's
   * followers all succeed with it in hand. Keyed per save so two saves in flight at once cannot overwrite each other's
   * entry: a success clears only the entries it was handed. Held in memory: a restart forgets it.
   */
  private unfollowed = new Map<number, PatchFile>();
  /** Counts saves in the order their writes landed, to key `unfollowed`. */
  private saves = 0;
  /** The last file save() stored, for a reader that must not act on a patch older than one just saved. */
  private lastSaved: PatchFile | null = null;

  /** Run, awaited, after every save and before patch:updated goes out. A hook that throws is said on [patch], and save() throws PatchLinksNotUpdated once the patch is stored and announced. */
  onSaved(hook: SavedHook): void {
    this.savedHooks.push(hook);
  }

  // POST /api/patch: an object with a list of sheets. A file in the shape
  // before sheets existed restores too, and migrate() reads it on load.
  private store = new DataStore<PatchFile>("patch.json", EMPTY, "config", {
    restoreCheck: checked((raw) => {
      const file = asObject(raw, "the patch");
      asArray(migrate(file as unknown as PatchFile).sheets, "the patch's sheets").forEach((sheet, i) =>
        asObject(sheet, `patch sheet ${i + 1}`),
      );
      return file;
    }),
  });

  /** What normalizePatch has left out of patch.json and said, so each is said once. */
  private said = new Set<string>();

  /**
   * The file migrated, and every sheet read by patch-shape.ts: a value the readers cannot take
   * (written by an older build, by hand or by a restore) is left out of what is answered, said on
   * [patch] once, and gone from patch.json at the next save. The editor never writes one, and
   * POST /api/patch refuses one.
   */
  private read(raw: PatchFile): PatchFile {
    const { file, dropped } = normalizePatch(migrate(raw));
    for (const what of dropped) {
      if (this.said.has(what)) continue;
      this.said.add(what);
      console.warn(`[patch] patch.json: ${scrub(what)}; it is left out`);
    }
    return file;
  }

  /** The full patch file (all sheets), migrated to the current shape. */
  async load(): Promise<PatchFile> {
    return this.read(await this.store.load());
  }

  /**
   * load(), for a reader that must not take the seed sheets for the patch (a stage plot link
   * would read "device removed" for every device): throws a StoreReadError (503) while
   * patch.json cannot be read, and while a damaged one has been set aside and nothing has
   * been saved over it since.
   */
  async loadStrict(): Promise<PatchFile> {
    const raw = await this.store.loadStrict();
    if (this.store.loadedFromCorrupt && raw === EMPTY) throw new StoreReadError("patch.json", null, "was damaged and set aside, and nothing has been saved since");
    return this.read(raw);
  }

  /** The newer of `read` and the last file this process saved: a read made before a save is overtaken by it. */
  newest(read: PatchFile): PatchFile {
    return this.lastSaved && this.lastSaved.updatedAt > read.updatedAt ? this.lastSaved : read;
  }

  /**
   * Replace the whole patch file, stamping updatedAt, and broadcast it on patch:updated.
   * Returns the saved file, or throws PatchLinksNotUpdated when the patch is saved and a follower failed. The broadcast is here and not in a route because every saver
   * owes it: /patch, the editor and the stage plots publisher all follow the patch on it,
   * and a view import that saved variants without one left them all on the old patch.
   */
  async save(file: PatchFile): Promise<PatchFile> {
    const next: PatchFile = { ...file, updatedAt: new Date().toISOString() };
    let before: PatchFile = EMPTY;
    let seq = 0;
    await this.store.update((prev) => {
      before = prev;
      seq = ++this.saves;
      return next;
    });
    this.lastSaved = next;
    const replaced = this.read(before);
    const taken = [...this.unfollowed.keys()].sort((a, b) => a - b);
    const befores = [...taken.map((k) => this.unfollowed.get(k)!), replaced];
    let failed: unknown = null;
    for (const hook of this.savedHooks) {
      try {
        await hook(befores, next);
      } catch (err) {
        console.error(`[patch] a follower of the saved patch failed: ${scrub(errorMessage(err))}`);
        failed ??= err;
      }
    }
    if (failed === null) for (const k of taken) this.unfollowed.delete(k);
    else this.unfollowed.set(seq, replaced);
    broadcast("patch:updated", next);
    if (failed !== null) throw new PatchLinksNotUpdated(failed);
    return next;
  }
}

export const patchStore = new PatchStore();
