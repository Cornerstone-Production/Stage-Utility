// What the /patch volunteer view shows, as plain functions of a sheet and its
// resolved patch. Both of the view's layouts (the stacked column for a phone and
// the two-column table for a desk) call these, so a filter or a note is decided in
// one place and the two layouts cannot disagree about which channels are on screen.
//
// Pure: no React, no I/O. The resolve step itself is lib/patch-resolve.

import { endpointKey, type ResolvedPatch } from "./patch-resolve";

export type ChainNodeKind = "source" | "hop" | "rack" | "console";
export interface ChainNode {
  text: string;
  kind: ChainNodeKind;
}

/** An endpoint with nothing set on it is an empty channel, not a row. */
export function isMeaningful(e: PatchEndpoint): boolean {
  return Boolean(e.label || e.consoleChannel || (e.path && e.path.length) || e.unused);
}

/** The Filter box: channel, source, mic, feed, console channel and owner. */
export function matchesQuery(e: PatchEndpoint, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${e.index} ${e.label ?? ""} ${e.mic ?? ""} ${e.feedType ?? ""} ${e.consoleChannel ?? ""} ${e.owner ?? ""}`.toLowerCase();
  return hay.includes(needle);
}

export interface RackSection {
  rack: PatchDevice;
  /** The rows that survive the filters, by channel. Never empty. */
  rows: PatchEndpoint[];
  /** Every set channel on the rack in this direction, filters ignored. */
  total: number;
}

/** One section per rack that has something to show in `dir`, after the filters. */
export function rackSections(
  sheet: PatchSheet,
  resolved: ResolvedPatch,
  dir: "in" | "out",
  filters: { changesOnly: boolean; q: string },
): RackSection[] {
  const out: RackSection[] = [];
  for (const rack of sheet.devices) {
    if (rack.kind !== "rack") continue;
    const set = resolved.endpoints.filter((e) => e.rackId === rack.id && e.dir === dir && isMeaningful(e));
    const rows = set
      .filter((e) => !filters.changesOnly || resolved.changed.has(endpointKey(e)))
      .filter((e) => matchesQuery(e, filters.q))
      .sort((a, b) => a.index - b.index);
    if (rows.length > 0) out.push({ rack, rows, total: set.length });
  }
  return out;
}

export const UNUSED_NOTE = "unused this week";

/** Why a channel differs from the standard patch, in the words the page uses. */
export function changeNote(e: PatchEndpoint, base: PatchEndpoint | undefined): string {
  if (e.unused) return UNUSED_NOTE;
  if ((base?.label ?? "") !== (e.label ?? "")) return base?.label ? `was ${base.label}` : "new";
  if (JSON.stringify(base?.path ?? []) !== JSON.stringify(e.path ?? [])) return "re-patched";
  return "";
}

export interface PatchChange {
  e: PatchEndpoint;
  note: string;
}

/** Every channel that differs from the standard patch, inputs first, by channel. */
export function collectChanges(sheet: PatchSheet, resolved: ResolvedPatch): PatchChange[] {
  const baseByKey = new Map(sheet.endpoints.map((e) => [endpointKey(e), e] as const));
  return resolved.endpoints
    .filter((e) => resolved.changed.has(endpointKey(e)))
    .sort((a, b) => (a.dir === b.dir ? a.index - b.index : a.dir === "in" ? -1 : 1))
    .map((e) => ({ e, note: changeNote(e, baseByKey.get(endpointKey(e))) }));
}

/** A signal path as nodes: source, the stage boxes it passes through, the rack, the console.
 *  Outputs flow the other way, so the same nodes reversed. */
export function chainNodes(e: PatchEndpoint, devices: PatchDevice[]): ChainNode[] {
  const devName = (id: string) => devices.find((d) => d.id === id)?.name ?? id;
  const hops: ChainNode[] = (e.path ?? []).map((h) => ({ text: `${devName(h.deviceId)} ${h.connector}`.trim(), kind: "hop" }));
  const rk = devices.find((d) => d.kind === "rack" && d.id === e.rackId);
  const rack: ChainNode = { text: `${rk?.name ?? "rack"} ${e.dir === "in" ? "in" : "out"} ${e.index}`, kind: "rack" };
  const console: ChainNode[] = e.consoleChannel ? [{ text: `console ${e.consoleChannel}`, kind: "console" }] : [];
  const src: ChainNode[] = e.label ? [{ text: e.label, kind: "source" }] : [];
  return e.dir === "in" ? [...src, ...hops, rack, ...console] : [...console, rack, ...hops, ...src];
}

/** The colour of the first box a channel comes through: the edge a row carries. */
export function sourceColor(e: PatchEndpoint, devices: PatchDevice[]): string | undefined {
  return devices.find((d) => d.id === e.path?.[0]?.deviceId)?.color;
}
