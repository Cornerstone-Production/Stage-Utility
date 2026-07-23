// patch-ripple.ts — DiGiCo-style "ripple" fill for the patch table.
//
// You arm a ripple count + fields, then setting one channel auto-fills a run of
// consecutive rack channels: numeric values increment, text/toggles copy. Pure +
// framework-free so the increment and fill logic can be unit-tested directly.

/** Fields of a PatchEndpoint that ripple can fill. */
export type RippleField = "path" | "consoleChannel" | "label" | "mic" | "phantom" | "feedType" | "owner";

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

/**
 * The ordered connector slots a device exposes in one direction: its generated
 * labels if any (from "Generate labels"), else `1..count`. `count` is the
 * direction-appropriate channel count set on the device at the top of the tab.
 */
function deviceSlots(d: PatchDevice, dir: "in" | "out"): PatchHop[] {
  const labels = dir === "in" ? d.inLabels : d.outLabels;
  const count = (dir === "in" ? d.inputs : d.outputs) || 0;
  if (labels && labels.length) return labels.map((c) => ({ deviceId: d.id, connector: c }));
  return Array.from({ length: count }, (_, i) => ({ deviceId: d.id, connector: String(i + 1) }));
}

/**
 * Flatten every source device's slots into one ordered sequence, in device-list
 * order. This is what lets ripple roll over device boundaries: once Snake A's 12
 * channels are used the next slot is Snake B's first, then the next device, etc.
 */
export function buildSourceSequence(stageDevices: PatchDevice[], dir: "in" | "out"): PatchHop[] {
  const seq: PatchHop[] = [];
  for (const d of stageDevices) seq.push(...deviceSlots(d, dir));
  return seq;
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
    case "owner":
      return { owner: String(value ?? "") };
    case "phantom":
      return { phantom: Boolean(value) };
  }
}

const keyOf = (rackId: string, dir: "in" | "out", index: number) => `${rackId}:${dir}:${index}`;

/**
 * The path for a given row-offset, rolling over device boundaries: the source
 * hop advances through the flattened device sequence, so it moves to the next
 * device when the current one runs out of channels. Downstream hops (if any) just
 * increment numerically. Returns null when the sequence is exhausted (no source
 * left to assign) so the caller can stop filling the path column.
 */
function slotPath(seq: PatchHop[], startSlot: number, offset: number, templateHops: PatchHop[]): PatchHop[] | null {
  const slot = seq[startSlot + offset];
  if (!slot) return null;
  const rest = templateHops.slice(1).map((h) => ({ ...h, connector: bumpValue(h.connector, offset) }));
  return [{ deviceId: slot.deviceId, connector: slot.connector }, ...rest];
}

/**
 * Apply a rippled edit: set `field` on the start row and fill the run below it.
 * The run is `count` channels (or to `rackChannels` for "end"), clamped to the
 * rack. Only the one field is written on each row — everything else is left
 * intact — so ripple never clobbers columns you didn't touch.
 *
 * The `path` field is device-aware when `stageDevices` is given: the source hop
 * walks the flattened device sequence (respecting each device's channel count),
 * rolling `Snake A 12 → Snake B 1 → …`. If the template's source hop isn't found
 * in that sequence (e.g. a free-typed connector), it falls back to a plain
 * numeric increment with no rollover.
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
  stageDevices?: PatchDevice[];
}): PatchEndpoint[] {
  const { endpoints, rackId, dir, startIndex, field, value, count, rackChannels, stageDevices } = params;
  const lastIndex =
    count === "end" ? Math.max(startIndex, rackChannels) : Math.min(rackChannels || Infinity, startIndex + count - 1);

  // For the path column, resolve the device sequence + where the template's
  // source hop sits in it (‑1 = not found → fall back to numeric bump).
  const templateHops = (value as PatchHop[]) ?? [];
  const seq = field === "path" && stageDevices ? buildSourceSequence(stageDevices, dir) : null;
  const startSlot =
    seq && templateHops[0]
      ? seq.findIndex((s) => s.deviceId === templateHops[0].deviceId && s.connector === templateHops[0].connector)
      : -1;

  const byKey = new Map(endpoints.map((e) => [keyOf(e.rackId, e.dir, e.index), e] as const));
  for (let idx = startIndex; idx <= lastIndex; idx++) {
    const offset = idx - startIndex;
    let patch: Partial<PatchEndpoint>;
    if (field === "path" && seq && startSlot !== -1) {
      const p = slotPath(seq, startSlot, offset, templateHops);
      if (p === null) break; // device sequence exhausted — stop filling the path
      patch = { path: p };
    } else {
      patch = valueAt(field, value, offset);
    }
    const k = keyOf(rackId, dir, idx);
    const existing = byKey.get(k) ?? { rackId, dir, index: idx };
    byKey.set(k, { ...existing, ...patch });
  }
  return [...byKey.values()];
}

/** Generate sequential connector labels: `prefix` + start..start+count-1. */
export function generateLabels(count: number, prefix: string, start: number): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => `${prefix}${start + i}`);
}
