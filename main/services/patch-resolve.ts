// Patch resolution: layer variant overlays + per-week tweaks over the default
// endpoint patch, and flag which endpoints differ from the default.
//
// Lives in main/ rather than renderer/ because the export builds on it too: the
// exported file has to be the patch that is on the screen, and two copies of this
// merge would eventually disagree about which one that is. Pure — no I/O, no React.
// Consumed by the variant editor, the /patch volunteer view, and patch-export.ts.

import type { PatchEndpoint, PatchSheet } from "../types/stage.js";

export function endpointKey(e: { rackId: string; dir: "in" | "out"; index: number }): string {
  return `${e.rackId}:${e.dir}:${e.index}`;
}

// Content fields an override/tweak may change (identity — rackId/dir/index — excluded).
// Every content field an operator can edit. A field missing here is not a
// cosmetic gap: diffEndpoints builds a variant's overrides from exactly this
// list, so an edit to a field it omits diffs to {} and is discarded on save.
// `owner` was missing — an ownership band typed into a variant or a week's
// tweaks vanished on the next render, with no error — and endpointsEqual reads
// the same list, so the /patch "what changed" highlight missed it too.
//
// If you add a field to PatchEndpoint that an operator can type into, add it
// here in the same change. patch-resolve.test.ts asserts this list covers every
// content field on the type, so the type checker and the test will tell you.
export const CONTENT_FIELDS = ["label", "mic", "phantom", "feedType", "consoleChannel", "path", "unused", "notes", "micSlotRef", "pcoPosition", "owner"] as const;

/** Empty-ish (null/undefined/"") values compare equal so "" vs undefined isn't a diff. */
function eq(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === undefined || v === null || v === "" || v === false;
  if (empty(a) && empty(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return a === b;
}

/** True when two endpoints have identical content (ignoring identity fields). */
export function endpointsEqual(a: PatchEndpoint, b: PatchEndpoint): boolean {
  return CONTENT_FIELDS.every((f) => eq((a as unknown as Record<string, unknown>)[f], (b as unknown as Record<string, unknown>)[f]));
}

/** Apply a set of overrides (keyed by endpointKey) onto a base endpoint list. */
export function mergeOverrides(base: PatchEndpoint[], overrides: Record<string, Partial<PatchEndpoint>>): PatchEndpoint[] {
  const map = new Map<string, PatchEndpoint>(base.map((e) => [endpointKey(e), { ...e }]));
  for (const [k, ov] of Object.entries(overrides)) {
    const cur = map.get(k);
    if (cur) map.set(k, { ...cur, ...ov });
    else if (ov.rackId && ov.dir && typeof ov.index === "number") map.set(k, { rackId: ov.rackId, dir: ov.dir, index: ov.index, ...ov });
  }
  return Array.from(map.values());
}

/** Diff an edited endpoint list against the default → minimal overrides (only the
 *  changed content fields, plus identity so each override is self-contained). */
export function diffEndpoints(next: PatchEndpoint[], base: PatchEndpoint[]): Record<string, Partial<PatchEndpoint>> {
  const baseByKey = new Map(base.map((e) => [endpointKey(e), e] as const));
  const out: Record<string, Partial<PatchEndpoint>> = {};
  for (const e of next) {
    const k = endpointKey(e);
    const b = baseByKey.get(k);
    const changed: Record<string, unknown> = {};
    for (const f of CONTENT_FIELDS) {
      if (!eq((b as unknown as Record<string, unknown> | undefined)?.[f], (e as unknown as Record<string, unknown>)[f])) changed[f] = (e as unknown as Record<string, unknown>)[f];
    }
    if (Object.keys(changed).length) out[k] = { rackId: e.rackId, dir: e.dir, index: e.index, ...changed } as Partial<PatchEndpoint>;
  }
  return out;
}

export interface ResolvedPatch {
  endpoints: PatchEndpoint[];
  /** endpointKeys that differ from the default (drives the "what changed" highlight). */
  changed: Set<string>;
  variantId: string | null;
  variantName: string | null;
}

/** Resolve the effective patch for a service type / plan, for ONE sheet:
 *  default → service-type standing variant → per-plan variant → per-plan week tweaks. */
export function resolvePatch(sheet: PatchSheet, ctx: { serviceTypeId?: string | null; planId?: string | null }): ResolvedPatch {
  const base = sheet.endpoints;
  const planEntry = ctx.planId ? sheet.assignments.byPlan[ctx.planId] : undefined;
  const variantId = planEntry?.variantId ?? (ctx.serviceTypeId ? sheet.assignments.byServiceType[ctx.serviceTypeId] : undefined) ?? null;
  const variant = variantId ? sheet.variants.find((v) => v.id === variantId) ?? null : null;
  const tweaks = planEntry?.tweaks ?? {};

  let endpoints = base;
  if (variant) endpoints = mergeOverrides(endpoints, variant.overrides);
  if (Object.keys(tweaks).length) endpoints = mergeOverrides(endpoints, tweaks);

  const baseByKey = new Map(base.map((e) => [endpointKey(e), e] as const));
  const changed = new Set<string>();
  for (const e of endpoints) {
    const b = baseByKey.get(endpointKey(e));
    if (!b || !endpointsEqual(b, e)) changed.add(endpointKey(e));
  }
  return { endpoints, changed, variantId: variant?.id ?? null, variantName: variant?.name ?? null };
}
