// stageplots-patch-link.ts — a connection point linked to a patch sheet device, resolved.
//
// One reading of the link for every surface: the editor's inspector and canvas, /stageplots
// and its tap, print, and the publisher, which sends the public page what this resolves and
// nothing else. Read-only against the patch: nothing here writes to it.
//
// A link resolves against the patch as the followed plan has it (resolvePatch: the default,
// the service type's standing variant, the plan's variant and its week tweaks), so a week
// that re-patches a channel lists that week's channels. The device's name and colour do not
// depend on the plan. A patch that cannot be read, or a sheet or device that is gone, leaves
// the point "unlinked" with the name and colour it last saved. Pure: no I/O, no React.

import { PATCH_COLORS, type PatchDevice, type PatchDeviceKind, type PatchEndpoint, type PatchFile, type PatchSheet } from "../types/patch.js";
import {
  STAGEPLOT_LIMITS,
  type PatchChannelRow,
  type PatchChannels,
  type PatchLink,
  type PlotItem,
  type PublishedItem,
} from "../types/stageplots.js";
import { resolvePatch } from "./patch-resolve.js";

/** The patch as read: the file, or that it could not be read (a 503, a damaged patch.json). */
export type PatchRead = { ok: true; file: PatchFile } | { ok: false };

/** The plan a link resolves its channels for: the one /patch and /stageplots follow. */
export interface PatchContext {
  serviceTypeId: string | null;
  planId: string | null;
}

export type LinkResolution =
  | {
      state: "linked";
      name: string;
      color: string | null;
      sheet: string;
      device: { kind: PatchDeviceKind; inputs: number; outputs: number };
      channels: PatchChannelRow[];
    }
  | { state: "unlinked"; reason: "unavailable" | "removed"; name: string; color: string | null };

const L = STAGEPLOT_LIMITS;
const PATH_CHARS = 80;
const SHEET_CHARS = 60;
const CHANNEL_CHARS = 20;

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

function rgb(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : null;
}

/**
 * A device colour as a plot item can carry it: one of the ten swatches, or null. The device
 * editor only offers the swatches, but a patch saved some other way may hold any "#rrggbb";
 * that takes the nearest swatch, so the point still reads in about the patch's colour and
 * the item still saves. Anything that is not a colour is none.
 */
export function swatchOf(color: unknown): string | null {
  if (typeof color !== "string" || !color) return null;
  const lower = color.toLowerCase();
  if ((PATCH_COLORS as readonly string[]).includes(lower)) return lower;
  const c = rgb(lower);
  if (!c) return null;
  let best: string = PATCH_COLORS[0];
  let bestD = Infinity;
  for (const s of PATCH_COLORS) {
    const [r, g, b] = rgb(s)!;
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

// POST /api/patch and a restore hold the patch to little more than "a list of sheets", so
// what is read here is read defensively: a number where text belongs is text, anything else
// nothing, and a list that is not one is empty. A malformed patch reads as fewer channels,
// never as a page that cannot draw or a venue that cannot be published.
const asText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const asList = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const asCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const asRecord = <T>(v: unknown): Record<string, T> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {});
const KINDS = ["rack", "snake", "drop-snake", "pocket", "wireless", "array", "other"] as const;

/** A device name as a point's label can carry it: trimmed, at most labelChars long. */
export function labelOf(name: unknown): string {
  return asText(name).trim().slice(0, L.labelChars);
}

const clip = (text: unknown, max: number) => asText(text).trim().slice(0, max);

/** "Ch 3" for a numbered console channel; the console's own name for one that is not. */
function channelName(cc: unknown): string {
  const t = clip(cc, CHANNEL_CHARS);
  return /^\d+$/.test(t) ? `Ch ${t}` : t;
}

/** The connector an endpoint uses on its own rack: the rack's label for it, else its number. */
function rackConnector(rack: PatchDevice, e: PatchEndpoint): string {
  const labels = asList<unknown>(e.dir === "in" ? rack.inLabels : rack.outLabels);
  return asText(labels[e.index - 1]) || String(e.index);
}

/**
 * The channels whose path runs through `device` on the resolved patch: every endpoint with a
 * hop on it, and, when the device is a rack, every set endpoint on that rack. Unused ones are
 * left out. Inputs first, then outputs, each in the sheet's rack order and then by channel.
 * Each row names only this device and its connector, never the rest of the chain.
 */
function channelsThrough(device: PatchDevice, devices: readonly PatchDevice[], endpoints: readonly PatchEndpoint[]): PatchChannelRow[] {
  const rackOrder = new Map(devices.map((d, i) => [d.id, i]));
  const rows: { e: PatchEndpoint; connector: string }[] = [];
  for (const e of endpoints) {
    if (!e || typeof e !== "object" || e.unused) continue;
    const path = asList<{ deviceId: unknown; connector: unknown } | null>(e.path);
    const hop = path.find((h) => h && h.deviceId === device.id);
    if (hop) rows.push({ e, connector: asText(hop.connector) });
    else if (e.rackId === device.id && (e.label || e.consoleChannel || path.length)) rows.push({ e, connector: rackConnector(device, e) });
  }
  rows.sort(
    (a, b) =>
      (a.e.dir === b.e.dir ? 0 : a.e.dir === "in" ? -1 : 1) ||
      (rackOrder.get(a.e.rackId) ?? Infinity) - (rackOrder.get(b.e.rackId) ?? Infinity) ||
      a.e.index - b.e.index,
  );
  const name = labelOf(device.name);
  return rows.slice(0, L.patchChannelsPerPoint).map(({ e, connector }) => ({
    channel: channelName(e.consoleChannel),
    label: clip(e.label, L.labelChars),
    path: clip(`${name}/${clip(connector, PATH_CHARS)}`, PATH_CHARS),
  }));
}

/** What a link shows: the device as the patch now has it, or the last name and colour, unlinked. */
export function resolvePatchLink(link: PatchLink, patch: PatchRead, ctx: PatchContext): LinkResolution {
  const last = { name: link.lastName, color: link.lastColor };
  if (!patch.ok || !Array.isArray(patch.file?.sheets)) return { state: "unlinked", reason: "unavailable", ...last };
  const sheet = asList<PatchSheet | null>(patch.file.sheets).find((s) => s?.id === link.sheetId);
  const devices = asList<PatchDevice | null>(sheet?.devices).filter((d): d is PatchDevice => !!d && typeof d === "object");
  const device = devices.find((d) => d.id === link.deviceId);
  if (!sheet || !device) return { state: "unlinked", reason: "removed", ...last };
  const assignments = asRecord<unknown>(sheet.assignments);
  const { endpoints } = resolvePatch(
    {
      ...sheet,
      endpoints: asList<PatchEndpoint | null>(sheet.endpoints).filter((e): e is PatchEndpoint => !!e && typeof e === "object"),
      variants: asList<PatchSheet["variants"][number]>(sheet.variants).filter((v) => v && typeof v === "object").map((v) => ({ ...v, overrides: asRecord(v.overrides) })),
      assignments: { byServiceType: asRecord(assignments.byServiceType), byPlan: asRecord(assignments.byPlan) },
    },
    ctx,
  );
  return {
    state: "linked",
    name: labelOf(device.name),
    color: swatchOf(device.color),
    sheet: clip(sheet.name, SHEET_CHARS),
    device: { kind: (KINDS as readonly unknown[]).includes(device.kind) ? device.kind : "other", inputs: asCount(device.inputs), outputs: asCount(device.outputs) },
    channels: channelsThrough(device, devices, endpoints),
  };
}

/** What a tap lists for a resolved link: its channels, or null to list the point's own inputs. */
export function tapChannels(r: LinkResolution | undefined): PatchChannels | null {
  return r?.state === "linked" && r.channels.length > 0 ? { sheet: r.sheet, channels: r.channels } : null;
}

export interface ResolvedItems {
  /** The items with each linked point's label and colour as resolved. Items that did not
   *  change are the same objects, and the list is the same list when none did. */
  items: PlotItem[];
  /** Each linked point's resolution, by item id. */
  links: Map<string, LinkResolution>;
}

/**
 * `items` as they are shown. `patch` null is the patch not read yet: the items as saved, whose
 * labels and colours are the last ones the links had.
 */
export function resolveItems(items: readonly PlotItem[], patch: PatchRead | null, ctx: PatchContext): ResolvedItems {
  const links = new Map<string, LinkResolution>();
  if (patch === null) return { items: items as PlotItem[], links };
  let changed = false;
  const out = items.map((it) => {
    if (it.type !== "conn" || !it.patchLink) return it;
    const r = resolvePatchLink(it.patchLink, patch, ctx);
    links.set(it.id, r);
    if (it.label === r.name && it.color === r.color) return it;
    changed = true;
    return { ...it, label: r.name, color: r.color };
  });
  return { items: changed ? out : (items as PlotItem[]), links };
}

/**
 * Every plot with its items as shown (resolveItems), and each plot's link resolutions by plot
 * id. A plot with nothing to resolve is the same object, and the list the same list.
 */
export function resolvePlots<P extends { id: string; items: PlotItem[] }>(
  plots: readonly P[],
  patch: PatchRead | null,
  ctx: PatchContext,
): { plots: P[]; links: Map<string, Map<string, LinkResolution>> } {
  const links = new Map<string, Map<string, LinkResolution>>();
  let changed = false;
  const out = plots.map((p) => {
    const r = resolveItems(p.items, patch, ctx);
    if (r.links.size > 0) links.set(p.id, r.links);
    if (r.items === p.items) return p;
    changed = true;
    return { ...p, items: r.items };
  });
  return { plots: changed ? out : (plots as P[]), links };
}

/**
 * Items to save: each linked point whose device resolves takes its name and colour as its
 * label, colour, lastName and lastColor, so what is stored is what was last shown. An unlinked
 * one is left as it is. The same list when nothing changes.
 */
export function stampLinks(items: readonly PlotItem[], links: ReadonlyMap<string, LinkResolution>): PlotItem[] {
  let changed = false;
  const out = items.map((it) => {
    const r = it.patchLink ? links.get(it.id) : undefined;
    if (!it.patchLink || r?.state !== "linked") return it;
    if (it.label === r.name && it.color === r.color && it.patchLink.lastName === r.name && it.patchLink.lastColor === r.color) return it;
    changed = true;
    return { ...it, label: r.name, color: r.color, patchLink: { ...it.patchLink, lastName: r.name, lastColor: r.color } };
  });
  return changed ? out : (items as PlotItem[]);
}

/** A point that will be published unlinked, for the [stageplots] log line saying so. */
export interface UnresolvedLink {
  label: string;
  reason: "unavailable" | "removed";
}

/**
 * Items as the public page gets them: never the link, a linked point's resolved label and
 * colour, and its channels when it has any. Every field is named here, so nothing reaches
 * the page because the stored item happens to carry it. Also the points that go unlinked.
 */
export function publishedItems(items: readonly PlotItem[], patch: PatchRead, ctx: PatchContext): { items: PublishedItem[]; unresolved: UnresolvedLink[] } {
  const resolved = resolveItems(items, patch, ctx);
  const unresolved: UnresolvedLink[] = [];
  const out = resolved.items.map((it): PublishedItem => {
    const r = resolved.links.get(it.id);
    if (r?.state === "unlinked") unresolved.push({ label: r.name, reason: r.reason });
    const patchView = tapChannels(r);
    return {
      id: it.id,
      type: it.type,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
      rotation: it.rotation,
      label: it.label,
      color: it.color,
      notes: it.notes,
      inputs: it.inputs,
      ...(it.symbol !== undefined ? { symbol: it.symbol } : {}),
      ...(it.textKind !== undefined ? { textKind: it.textKind } : {}),
      ...(it.points !== undefined ? { points: it.points } : {}),
      ...(it.dashed !== undefined ? { dashed: it.dashed } : {}),
      ...(patchView ? { patch: patchView } : {}),
    };
  });
  return { items: out, unresolved };
}
