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

import { collectRefs } from "./view-refs.js";
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

export async function buildViewBundle(rootId: string): Promise<ViewBundle> {
  const all = await viewsStore.load();
  const root = all.find((v) => v.id === rootId);
  // Loudly, not an empty bundle: a file that downloads and does nothing at the
  // far end is the worst outcome here.
  if (!root) throw new Error(`export — unknown view ${rootId}`);

  const refs = collectRefs(all, rootId);
  const views = [
    root,
    ...refs.embeddedViewIds.map((id) => all.find((v) => v.id === id)).filter((v) => !!v),
  ];

  // Slot rows are keyed by view id (a slots view) or by layout object id (an
  // inline slots-grid). Both are collected, for EVERY service type: the
  // destination may run different ones, and dropping them loses real work.
  const slotsFile = await slotsStore.all();
  const slots: ViewBundle["sideData"]["slots"] = {};
  for (const key of [...views.map((v) => v.id), ...refs.objectIds]) {
    if (slotsFile[key]) slots[key] = slotsFile[key];
  }

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

  // A missing image is reported by its absence from the map, not by refusing to
  // export. An export that fails because one logo was deleted is worse.
  const images: Record<string, string> = {};
  for (const ref of refs.imageFiles) {
    const img = await readLayoutImage(ref.slice("layout-images/".length));
    if (img) images[ref] = img.data.toString("base64");
  }

  const settings = await settingsStore.load();
  return {
    kind: "stage-utility-view",
    version: 1,
    appVersion: appVersion(),
    createdAt: new Date().toISOString(),
    source: { server: settings.appName || "Stage Utility" },
    views,
    sideData: { slots, notes, scriptviewLayouts },
    targets: { osc, rosstalk },
    images,
  };
}
