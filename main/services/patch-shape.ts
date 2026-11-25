// patch-shape.ts — the one reader of a patch sheet's structure.
//
// resolvePatch, /patch, the patch export and stage plots publishing all read fields off a
// sheet's variants, overrides and assignments, so a null or a list where an object belongs
// throws in every one of them. POST /api/patch refuses such a sheet (patchShapeProblem); a
// patch.json already holding one (an older build, a hand edit, a restore) is read through
// normalizePatch on load, the values that are not the right shape left out and said once
// (patch-store.ts). Everything else on a sheet, its devices' and endpoints' own fields among
// it, is kept as it is.
//
// Pure, so the renderer's stage plots picker reads a sheet by the same rules.

import type { PatchEndpoint, PatchFile, PatchSheet } from "../types/patch.js";
import { isRecord } from "./is-record.js";

type Overrides = Record<string, Partial<PatchEndpoint>>;
type ByPlan = PatchSheet["assignments"]["byPlan"];

/** Told each value left out, in a sentence naming where it was. */
type Dropped = (what: string) => void;

const quiet: Dropped = () => undefined;

/** A list of objects: anything else in it, or a value that is not a list, is left out and said. */
function records(v: unknown, where: string, drop: Dropped): Record<string, unknown>[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    drop(`${where} is not a list`);
    return [];
  }
  return v.filter((x, i) => isRecord(x) || (drop(`${where} ${i + 1} is not an object`), false)) as Record<string, unknown>[];
}

/** Overrides keyed by endpoint, each an object (resolvePatch reads fields off it). An override that is not one, a list among them, is left out and said. */
export function readOverrides(v: unknown, drop: Dropped = quiet, where = "the overrides"): Overrides {
  if (v === undefined) return {};
  if (!isRecord(v)) {
    drop(`${where} are not an object`);
    return {};
  }
  return Object.fromEntries(Object.entries(v).filter(([k, ov]) => isRecord(ov) || (drop(`${where}: "${k}" is not an object`), false))) as Overrides;
}

/** Service type to the id of its standing variant: text only. */
function readByServiceType(v: unknown, drop: Dropped, where: string): Record<string, string> {
  if (v === undefined) return {};
  if (!isRecord(v)) {
    drop(`${where}'s service type variants are not an object`);
    return {};
  }
  return Object.fromEntries(Object.entries(v).filter(([k, id]) => typeof id === "string" || (drop(`${where}'s variant for service type "${k}" is not text`), false))) as Record<string, string>;
}

/** Plan to its entry: an object, its variantId text when present, its tweaks overrides. */
function readByPlan(v: unknown, drop: Dropped = quiet, where = "the sheet"): ByPlan {
  if (v === undefined) return {};
  if (!isRecord(v)) {
    drop(`${where}'s plan assignments are not an object`);
    return {};
  }
  const out: [string, ByPlan[string]][] = [];
  for (const [planId, entry] of Object.entries(v)) {
    if (!isRecord(entry)) {
      drop(`${where}'s assignment for plan "${planId}" is not an object`);
      continue;
    }
    const { variantId, tweaks, ...rest } = entry;
    if (variantId !== undefined && typeof variantId !== "string") drop(`${where}'s variant for plan "${planId}" is not text`);
    out.push([
      planId,
      {
        ...rest,
        ...(typeof variantId === "string" ? { variantId } : {}),
        ...(tweaks !== undefined ? { tweaks: readOverrides(tweaks, drop, `${where}'s tweaks for plan "${planId}"`) } : {}),
      } as ByPlan[string],
    ]);
  }
  return Object.fromEntries(out) as ByPlan;
}

/** One sheet with its structure read by the rules above; every other field kept as it was. */
export function readSheetShape(s: Record<string, unknown>, drop: Dropped = quiet, where = "the sheet"): PatchSheet {
  const assignments = s.assignments === undefined ? {} : s.assignments;
  if (!isRecord(assignments)) drop(`${where}'s assignments are not an object`);
  const a = isRecord(assignments) ? assignments : {};
  return {
    ...s,
    devices: records(s.devices, `${where}'s device`, drop),
    endpoints: records(s.endpoints, `${where}'s endpoint`, drop),
    variants: records(s.variants, `${where}'s variant`, drop).map((v) => ({
      ...v,
      overrides: readOverrides(v.overrides, drop, `${where}'s variant "${String(v.name ?? v.id ?? "")}" overrides`),
    })),
    assignments: { ...a, byServiceType: readByServiceType(a.byServiceType, drop, where), byPlan: readByPlan(a.byPlan, drop, where) },
  } as unknown as PatchSheet;
}

/** `file` with every sheet read by readSheetShape, and what was left out. A sheet that is not an object is left out. */
export function normalizePatch(file: PatchFile): { file: PatchFile; dropped: string[] } {
  const dropped: string[] = [];
  const drop: Dropped = (what) => void dropped.push(what);
  const sheets = records((file as unknown as Record<string, unknown>).sheets, "patch sheet", drop).map((s, i) =>
    readSheetShape(s, drop, `sheet ${i + 1}${typeof s.name === "string" && s.name ? ` ("${s.name}")` : ""}`),
  );
  return { file: { ...file, sheets }, dropped };
}

/** Why a patch file has a value the readers cannot take, or null: what POST /api/patch refuses. */
export function patchShapeProblem(file: unknown): string | null {
  if (!isRecord(file) || !Array.isArray(file.sheets)) return "body.file (PatchFile) required";
  return normalizePatch(file as unknown as PatchFile).dropped[0] ?? null;
}
