// What the /patch volunteer view shows, as plain functions of a sheet and its
// resolved patch. Both of the view's layouts (the stacked column for a phone and
// the two-column table for a desk) call these, so a filter or a note is decided in
// one place and the two layouts cannot disagree about which channels are on screen.
//
// Pure: no React, no I/O. The resolve step itself is lib/patch-resolve.

import { endpointKey, type ResolvedPatch } from "./patch-resolve";

export interface ChainNode {
  text: string;
  kind: "source" | "hop" | "rack" | "console";
}

/** An endpoint with nothing set on it is an empty channel, not a row. */
export function isMeaningful(e: PatchEndpoint): boolean {
  return Boolean(e.label || e.consoleChannel || e.path?.length || e.unused);
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

/** Why a channel differs from the standard patch, in the words the page uses.
 *  Only meaningful for a channel in the changed set. */
export function changeNote(e: PatchEndpoint, base: PatchEndpoint | undefined): string {
  // Unused this week only when the standard patch had it in use; one that was
  // already unused and changed some other way falls through to say that.
  if (e.unused && !base?.unused) return UNUSED_NOTE;
  if ((base?.label ?? "") !== (e.label ?? "")) return base?.label ? `was ${base.label}` : "new";
  if (JSON.stringify(base?.path ?? []) !== JSON.stringify(e.path ?? [])) return "re-patched";
  // Something else about the channel changed (mic, 48V, feed, console channel,
  // owner). A tinted row with nothing written on it says it by colour alone.
  return "changed";
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
  const rack: ChainNode = { text: `${rk?.name ?? "rack"} ${e.dir} ${e.index}`, kind: "rack" };
  const consoleNode: ChainNode[] = e.consoleChannel ? [{ text: `console ${e.consoleChannel}`, kind: "console" }] : [];
  const src: ChainNode[] = e.label ? [{ text: e.label, kind: "source" }] : [];
  return e.dir === "in" ? [...src, ...hops, rack, ...consoleNode] : [...consoleNode, rack, ...hops, ...src];
}

/** The colour of the first box a channel comes through: the edge a row carries. */
export function sourceColor(e: PatchEndpoint, devices: PatchDevice[]): string | undefined {
  return devices.find((d) => d.id === e.path?.[0]?.deviceId)?.color;
}

/** Rows paired with the owner heading that opens their run, if one does. An
 *  unowned row ends the run, so the same owner after it gets its heading again. */
export function withOwnerHeadings(rows: PatchEndpoint[]): { e: PatchEndpoint; heading?: string }[] {
  let last: string | undefined;
  return rows.map((e) => {
    const owner = e.owner?.trim() || undefined;
    const heading = owner !== undefined && owner !== last ? owner : undefined;
    last = owner;
    return { e, heading };
  });
}

/** What to say when no rack has a row to show. */
export function noRowsMessage(dir: "in" | "out", filters: { changesOnly: boolean; q: string }): string {
  if (filters.changesOnly || filters.q.trim()) return "No channels match.";
  return `No ${dir === "in" ? "inputs" : "outputs"} on this sheet.`;
}
