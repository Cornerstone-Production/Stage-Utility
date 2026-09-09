// Turn one service type's whole setup into a file.
//
// A "plan" here is a SERVICE TYPE, not a date: the boards, layouts, patch
// variant and presets that type comes back to every week. Per-plan overrides are
// one week's exception keyed by a Planning Center plan id, so they never travel
// — the same rule view-export follows.
//
// The file is the view bundle, unchanged, with `plan` and `roots` on top and two
// optional sections in `sideData`. A plain view export is byte for byte what it
// always was, and an older install's importer reads a plan file as the views it
// contains.
//
// What does NOT travel is the same list view-export refuses, plus the patch RIG:
// devices, endpoints and the default patch are the building's, and a variant is
// an overlay of overrides on top of whatever the destination's own patch says.

import { collectBundleParts, pickSlots, bundleEnvelope } from "./view-export.js";
import { walkLayoutObjects } from "./view-refs.js";
import { viewsStore } from "./views-store.js";
import { slotsStore } from "./slots-store.js";
import { patchStore } from "./patch-store.js";
import { presetsStore } from "./presets-store.js";
import { stageController } from "./stage-controller.js";
import { scrub } from "./scrub.js";
import type { ViewBundle } from "../types/view-bundle.js";

export interface PlanExportOptions {
  serviceTypeId: string;
  /** "type": this type's boards only. "all": every type's board on the views a
   *  plan export drags in, which is what a destination running other types on
   *  the same layouts wants. */
  slots: "type" | "all";
  patch: boolean;
  presets: boolean;
}

/** What the export dialog counts before an operator commits to a download. */
export interface PlanExportPreview {
  serviceTypeName: string;
  views: number;
  boards: number;
  rows: number;
  patchVariants: { sheetName: string; variantName: string }[];
  presets: number;
  scriptviewLayouts: number;
}

/**
 * How the service type's NAME is looked up.
 *
 * Injected rather than reached for, so the unit tests exercise the real bundle
 * code path against a fixed list instead of standing up Planning Center. The
 * default is the controller, which is where the routes and the UI get the same
 * list from.
 */
export interface PlanExportDeps {
  listServiceTypes(): Promise<{ id: string; name: string }[]>;
}

const controllerTypes: PlanExportDeps = {
  listServiceTypes: () => stageController.listServiceTypes(),
};

/** Everything a plan export needs, built once. `buildPlanBundle` logs it;
 *  `planExportPreview` counts it. Neither counts anything twice. */
async function buildPlan(
  opts: PlanExportOptions,
  deps: PlanExportDeps,
): Promise<{ bundle: ViewBundle; boards: number; rows: number }> {
  const types = await deps.listServiceTypes();
  const type = types.find((t) => t.id === opts.serviceTypeId);
  // Loudly, before anything is read: a bundle naming a service type this server
  // has never heard of is a file the far end cannot describe either.
  if (!type) throw new Error(`plan export — unknown service type ${opts.serviceTypeId}`);

  const all = await viewsStore.load();
  const defaults = await slotsStore.allDefaults();

  // A key is a view id or a layout OBJECT id, and only the object case needs the
  // layouts walked. One walk over every view builds the object -> view map; the
  // alternative was a walk per key.
  const ownerOfObject = new Map<string, string>();
  for (const v of all) {
    if (!v.layout) continue;
    walkLayoutObjects(v.layout.objects, (o) => ownerOfObject.set(o.id, v.id));
  }

  // A board that exists but is empty still counts: an operator who cleared a
  // board meant to clear it, and the view it lives on is still part of this
  // type's setup.
  const boardKeys = Object.entries(defaults)
    .filter(([, byType]) => Object.hasOwn(byType, opts.serviceTypeId))
    .map(([key]) => key);

  const byId = new Set(all.map((v) => v.id));
  const roots: string[] = [];
  for (const key of boardKeys) {
    const viewId = byId.has(key) ? key : ownerOfObject.get(key);
    // A key whose view is gone is stale slots data, not a root. Skipped rather
    // than fatal: it would refuse an export over rows nothing renders.
    if (viewId && !roots.includes(viewId)) roots.push(viewId);
  }

  if (roots.length === 0) {
    throw new Error(`plan export — nothing to export for ${type.name}: no view has a slot board for it`);
  }

  const parts = await collectBundleParts(all, roots);
  const slots = pickSlots(defaults, parts, opts.slots === "type" ? opts.serviceTypeId : null);

  let boards = 0;
  let rows = 0;
  for (const byType of Object.values(slots)) {
    for (const board of Object.values(byType)) {
      boards++;
      rows += board.length;
    }
  }

  const patchVariants: NonNullable<ViewBundle["sideData"]["patchVariants"]> = [];
  if (opts.patch) {
    for (const sheet of (await patchStore.load()).sheets) {
      const assigned = sheet.assignments?.byServiceType ?? {};
      if (!Object.hasOwn(assigned, opts.serviceTypeId)) continue;
      const variant = sheet.variants.find((v) => v.id === assigned[opts.serviceTypeId]);
      // An assignment naming a variant that is not on the sheet is broken here
      // already; carrying the id alone would put the same break on the far end.
      if (variant) patchVariants.push({ sheetId: sheet.id, sheetName: sheet.name, variant });
    }
  }

  const presets = opts.presets ? await presetsStore.load() : [];

  const bundle: ViewBundle = {
    ...(await bundleEnvelope()),
    plan: { serviceTypeId: type.id, serviceTypeName: type.name, slotsScope: opts.slots },
    roots,
    views: parts.views,
    sideData: {
      slots,
      notes: parts.notes,
      scriptviewLayouts: parts.scriptviewLayouts,
      ...(patchVariants.length ? { patchVariants } : {}),
      ...(presets.length ? { presets } : {}),
    },
    targets: parts.targets,
    images: parts.images,
    ...(parts.missingImages.length ? { missingImages: parts.missingImages } : {}),
  };

  return { bundle, boards, rows };
}

export async function buildPlanBundle(
  opts: PlanExportOptions,
  deps: PlanExportDeps = controllerTypes,
): Promise<ViewBundle> {
  const { bundle, boards } = await buildPlan(opts, deps);
  const patch = bundle.sideData.patchVariants?.length ?? 0;
  // The counts are built first and scrubbed as one string rather than
  // interpolated raw. They are numbers and cannot forge a line, but the log
  // scan's barrier is syntactic on purpose — an exemption for "obviously safe"
  // is how a scan stops being a scan.
  const counts =
    `${bundle.views.length} views, ${boards} boards, ` +
    `patch ${patch ? "yes" : "no"}, presets ${bundle.sideData.presets?.length ?? 0}`;
  console.log(`[plan-export] ${scrub(bundle.plan!.serviceTypeName)}: ${scrub(counts)}`);
  return bundle;
}

/**
 * What the dialog shows before the download.
 *
 * Built by the SAME code path with every section on, so the counts cannot
 * disagree with the file — INCLUDING the slots scope, which the caller passes.
 * Counted always at "type", the boards and rows line sat still while the
 * segmented control moved to "every type on those views" and the file grew.
 */
export async function planExportPreview(
  serviceTypeId: string,
  slots: PlanExportOptions["slots"] = "type",
  deps: PlanExportDeps = controllerTypes,
): Promise<PlanExportPreview> {
  const { bundle, boards, rows } = await buildPlan(
    { serviceTypeId, slots, patch: true, presets: true },
    deps,
  );
  return {
    serviceTypeName: bundle.plan!.serviceTypeName,
    views: bundle.views.length,
    boards,
    rows,
    patchVariants: (bundle.sideData.patchVariants ?? []).map((p) => ({
      sheetName: p.sheetName,
      variantName: p.variant.name,
    })),
    presets: bundle.sideData.presets?.length ?? 0,
    scriptviewLayouts: bundle.sideData.scriptviewLayouts.length,
  };
}
