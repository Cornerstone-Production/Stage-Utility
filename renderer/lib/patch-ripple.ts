// patch-ripple.ts — DiGiCo-style "ripple" fill for the patch table.
//
// You arm a ripple count + fields, then setting one channel auto-fills a run of
// consecutive rack channels: numeric values increment, text/toggles copy. Pure +
// framework-free so the increment and fill logic can be unit-tested directly.

/** Fields of a PatchEndpoint that ripple can fill. */
export type RippleField = "path" | "consoleChannel" | "label" | "mic" | "phantom" | "feedType";

/** How far a ripple reaches from the edited row: a fixed run, or to the rack end. */
export type RippleCount = number | "end";

/**
 * Increment the trailing integer in a string by `delta`, preserving any prefix,
 * suffix, and zero-padding. `"1"→"2"`, `"B-1"→"B-2"`, `"09"→"10"`, `"L-3-2"→…`.
 * A value with no trailing number (e.g. `"L"`, `""`) is returned unchanged so it
 * copies down rather than corrupting.
 */
export function bumpValue(v: string, delta: number): string {
  if (delta === 0 || !v) return v;
  const m = /^(.*?)(\d+)(\D*)$/.exec(v);
  if (!m) return v;
  const [, prefix, digits, suffix] = m;
  const n = parseInt(digits, 10) + delta;
  if (n < 0) return v; // never ripple below zero
  return `${prefix}${String(n).padStart(digits.length, "0")}${suffix}`;
}

/** Increment every numeric connector in a hop chain by `delta`, keeping devices. */
export function bumpHops(hops: PatchHop[], delta: number): PatchHop[] {
  return hops.map((h) => ({ ...h, connector: bumpValue(h.connector, delta) }));
}

/** Whether a field increments (numeric) or just copies down. */
function increments(field: RippleField): boolean {
  return field === "path" || field === "consoleChannel" || field === "label";
}

/** The value a given row-offset gets for one field, from the template value. */
function valueAt(field: RippleField, value: unknown, offset: number): Partial<PatchEndpoint> {
  const delta = increments(field) ? offset : 0;
  switch (field) {
    case "path":
      return { path: bumpHops((value as PatchHop[]) ?? [], delta) };
    case "consoleChannel":
      return { consoleChannel: bumpValue(String(value ?? ""), delta) };
    case "label":
      return { label: bumpValue(String(value ?? ""), delta) };
    case "mic":
      return { mic: String(value ?? "") };
    case "feedType":
      return { feedType: String(value ?? "") };
    case "phantom":
      return { phantom: Boolean(value) };
  }
}

const keyOf = (rackId: string, dir: "in" | "out", index: number) => `${rackId}:${dir}:${index}`;

/**
 * Apply a rippled edit: set `field` on the start row and fill the run below it.
 * The run is `count` channels (or to `rackChannels` for "end"), clamped to the
 * rack. Only the one field is written on each row — everything else is left
 * intact — so ripple never clobbers columns you didn't touch.
 */
export function rippleEndpoints(params: {
  endpoints: PatchEndpoint[];
  rackId: string;
  dir: "in" | "out";
  startIndex: number;
  field: RippleField;
  value: unknown;
  count: RippleCount;
  rackChannels: number;
}): PatchEndpoint[] {
  const { endpoints, rackId, dir, startIndex, field, value, count, rackChannels } = params;
  const lastIndex =
    count === "end" ? Math.max(startIndex, rackChannels) : Math.min(rackChannels || Infinity, startIndex + count - 1);

  const byKey = new Map(endpoints.map((e) => [keyOf(e.rackId, e.dir, e.index), e] as const));
  for (let idx = startIndex; idx <= lastIndex; idx++) {
    const k = keyOf(rackId, dir, idx);
    const existing = byKey.get(k) ?? { rackId, dir, index: idx };
    byKey.set(k, { ...existing, ...valueAt(field, value, idx - startIndex) });
  }
  return [...byKey.values()];
}

/** Generate sequential connector labels: `prefix` + start..start+count-1. */
export function generateLabels(count: number, prefix: string, start: number): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => `${prefix}${start + i}`);
}
