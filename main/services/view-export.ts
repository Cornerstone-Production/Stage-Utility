// Turn a view into a file.
//
// Reuses the config snapshot's envelope — kind, version, appVersion, createdAt
// and a `<dir>/<file>` base64 image map — so there is one bundle shape in this
// codebase rather than two.
//
// What travels is decided in view-refs.ts. What does NOT travel is the
// building's rig: wireless connections, integration configs, ProPresenter
// instances, SenSource zones and Smaart meters. A mobile deployment runs a
// duplicate SET of gear, so shipping the source's connection definitions would
// aim it at receivers that are not in the room — worse than an unbound object,
// because it looks configured.

import { collectRefsFrom } from "./view-refs.js";
import { viewsStore } from "./views-store.js";
import { slotsStore } from "./slots-store.js";
import { notesStore } from "./notes-store.js";
import { scriptViewLayoutsStore } from "./scriptview-layouts-store.js";
import { oscStore } from "./osc-store.js";
import { rosstalkStore } from "./rosstalk-store.js";
import { settingsStore } from "./settings-store.js";
import { readLayoutImage } from "./layout-image-store.js";
import { appVersion } from "./config-snapshot.js";
import type { ViewBundle } from "../types/view-bundle.js";
import type { View } from "../types/views.js";
import type { ViewRefs } from "../types/view-bundle.js";
import type { Slot } from "../types/stage.js";

/**
 * Everything a bundle carries that is derived from a set of ROOT views.
 *
 * Factored out because a plan export is the same body over several roots at
 * once. buildViewBundle and buildPlanBundle both call this; they differ only in
 * which roots they start from, which slot boards they keep, and the two
 * plan-only sections.
 */
export interface ViewBundleParts {
  /** Roots first, in the order asked for, then everything they embed. */
  views: View[];
  refs: ViewRefs;
  notes: Record<string, unknown>;
  scriptviewLayouts: ViewBundle["sideData"]["scriptviewLayouts"];
  targets: ViewBundle["targets"];
  images: Record<string, string>;
  missingImages: string[];
}

/** Root ids that name no view here, so a caller can refuse rather than ship a
 *  bundle that is quietly short a layout. */
export function unknownRoots(all: readonly View[], rootIds: readonly string[]): string[] {
  const have = new Set(all.map((v) => v.id));
  return rootIds.filter((id) => !have.has(id));
}

export async function collectBundleParts(
  all: readonly View[],
  rootIds: readonly string[],
): Promise<ViewBundleParts> {
  const refs = collectRefsFrom(all, rootIds);
  const byId = new Map(all.map((v) => [v.id, v]));
  const views = [
    ...rootIds.map((id) => byId.get(id)).filter((v) => !!v),
    ...refs.embeddedViewIds.map((id) => byId.get(id)).filter((v) => !!v),
  ];

  await notesStore.init();
  const notes: Record<string, unknown> = {};
  for (const id of refs.objectIds) {
    const n = notesStore.get(id);
    if (n && Object.keys(n).length) notes[id] = n;
  }

  const wanted = new Set(views.map((v) => v.scriptViewLayoutId).filter((id) => !!id));
  const scriptviewLayouts = wanted.size
    ? (await scriptViewLayoutsStore.load()).filter((l) => wanted.has(l.id))
    : [];

  const osc = (await oscStore.load()).filter((t) => refs.oscTargetIds.includes(t.id));
  const rosstalk = (await rosstalkStore.loadTargets()).filter((t) => refs.rosstalkTargetIds.includes(t.id));

  // A missing image does not refuse the export — one deleted logo should not
  // block the other twenty objects — but it IS named, so the import can tell
  // somebody. An export is a plain download with no report of its own.
  const images: Record<string, string> = {};
  const missingImages: string[] = [];
  for (const ref of refs.imageFiles) {
    const img = await readLayoutImage(ref.slice("layout-images/".length));
    if (img) images[ref] = img.data.toString("base64");
    else missingImages.push(ref);
  }

  return { views, refs, notes, scriptviewLayouts, targets: { osc, rosstalk }, images, missingImages };
}

/**
 * The slot boards on these views' keys.
 *
 * Slot rows are keyed by view id (a slots view) or by layout object id (an
 * inline slots-grid). Both are collected.
 *
 * `onlyServiceTypeId` null keeps EVERY service type, which is what a view export
 * does: the destination may run different ones, and dropping them loses real
 * work. A plan export scoped to one type passes that type's id.
 *
 * DEFAULTS only, in both cases. A per-plan override is one week's exception,
 * keyed by a Planning Center plan id that means nothing on the far end.
 */
export function pickSlots(
  allDefaults: Record<string, Record<string, Slot[]>>,
  parts: ViewBundleParts,
  onlyServiceTypeId: string | null,
): ViewBundle["sideData"]["slots"] {
  const slots: ViewBundle["sideData"]["slots"] = {};
  for (const key of [...parts.views.map((v) => v.id), ...parts.refs.objectIds]) {
    const byType = allDefaults[key];
    if (!byType) continue;
    if (onlyServiceTypeId === null) {
      slots[key] = byType;
      continue;
    }
    if (Object.hasOwn(byType, onlyServiceTypeId)) {
      slots[key] = { [onlyServiceTypeId]: byType[onlyServiceTypeId]! };
    }
  }
  return slots;
}

/** kind / version / stamps / who exported it — identical for both bundle kinds. */
export async function bundleEnvelope(): Promise<Pick<ViewBundle, "kind" | "version" | "appVersion" | "createdAt" | "source">> {
  const settings = await settingsStore.load();
  return {
    kind: "stage-utility-view",
    version: 1,
    appVersion: appVersion(),
    createdAt: new Date().toISOString(),
    source: { server: settings.appName || "Stage Utility" },
  };
}

export async function buildViewBundle(rootId: string): Promise<ViewBundle> {
  const all = await viewsStore.load();
  // Loudly, not an empty bundle: a file that downloads and does nothing at the
  // far end is the worst outcome here.
  if (unknownRoots(all, [rootId]).length) throw new Error(`export — unknown view ${rootId}`);

  const parts = await collectBundleParts(all, [rootId]);
  const slots = pickSlots(await slotsStore.allDefaults(), parts, null);

  return {
    ...(await bundleEnvelope()),
    views: parts.views,
    sideData: { slots, notes: parts.notes, scriptviewLayouts: parts.scriptviewLayouts },
    targets: parts.targets,
    images: parts.images,
    ...(parts.missingImages.length ? { missingImages: parts.missingImages } : {}),
  };
}
