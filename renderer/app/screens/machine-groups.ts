// Which devices on Screens are outputs of one Mac, and so are shown as one
// machine rather than as look-alikes.
//
// The Mac output helper announces one device per output, with the id
// `<the Mac's device id>.<output key>` and the Mac's hostname. Every one that is still unclaimed is a row under the
// Mac's header, and every sibling already set up is a dimmed row beside them, so
// "SDI 1 is Main stage left" reads next to "SDI 2 is not set up". A device with no
// `output` is not grouped with anything and keeps the list it has always had.

import type { SeenDevice } from "@main/types/kiosk";
import type { PublicDevice } from "@main/services/kiosk-devices-store";

export type MachineRow =
  | { state: "unclaimed"; device: SeenDevice }
  | { state: "bound"; device: PublicDevice };

export interface Machine {
  /** What the group was found by: the Mac's device id, or for an output whose id
   *  names no Mac, the first MAC it carried. For a React key. */
  key: string;
  hostname?: string;
  os?: string;
  ip?: string;
  /** Displays first, then SDI ports, each in the order a person counts them. */
  rows: MachineRow[];
}

export interface Grouped {
  machines: Machine[];
  /** Everything else, in the order it came. */
  plain: SeenDevice[];
}

const KIND_ORDER = { display: 0, decklink: 1 } as const;

/** "SDI 2" before "SDI 10", which a plain string compare would not give. */
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function rowOrder(a: MachineRow, b: MachineRow): number {
  const ao = a.device.output!;
  const bo = b.device.output!;
  return KIND_ORDER[ao.kind] - KIND_ORDER[bo.kind] || natural.compare(ao.name, bo.name) || natural.compare(a.device.id, b.device.id);
}

/**
 * The Mac an output belongs to: its device id up to the LAST ".", or undefined
 * for an id with none.
 *
 * The output key after the dot never contains one, so the last dot is the
 * boundary even when the Mac's own id has a dot in it.
 */
export function machineIdOf(deviceId: string): string | undefined {
  const dot = deviceId.lastIndexOf(".");
  return dot > 0 ? deviceId.slice(0, dot) : undefined;
}

/**
 * Split what Screens has heard into machines and plain devices.
 *
 * Outputs belong to the same machine when their ids name the same Mac, NOT when
 * they share a MAC address: two Intel Macs with a T2 chip report the same MAC
 * (the iBridge's), and grouping on it put two machines' outputs under one
 * header. The MAC is used only for an output whose id names no Mac, and groups
 * found that way merge when one output carries MACs of both. A machine is listed
 * only while at least one of its outputs is not set up: a Mac whose every output
 * has a screen has nothing left to offer here, and the screens themselves say
 * where they are.
 */
export function groupByMachine(seen: readonly SeenDevice[], bound: readonly PublicDevice[]): Grouped {
  const plain: SeenDevice[] = [];
  let machines: Machine[] = [];
  const byId = new Map<string, Machine>();
  // MAC -> the machine it belongs to, for outputs with no Mac in their id.
  const byMac = new Map<string, Machine>();

  const lower = (macs: readonly string[]) => macs.map((m) => m.toLowerCase());
  const placeByMac = (macs: readonly string[]): Machine[] => [
    ...new Set(macs.map((x) => byMac.get(x)).filter((x): x is Machine => !!x)),
  ];

  const machineFor = (d: SeenDevice): Machine | undefined => {
    const id = machineIdOf(d.id);
    if (id !== undefined) {
      let m = byId.get(id);
      if (!m) {
        m = { key: id, hostname: d.hostname, os: d.os, ip: d.ip, rows: [] };
        byId.set(id, m);
        machines.push(m);
      }
      return m;
    }
    const macs = lower(d.macs);
    if (macs.length === 0) return undefined;
    const [first, ...bridged] = placeByMac(macs);
    let m = first;
    if (!m) {
      m = { key: macs[0], hostname: d.hostname, os: d.os, ip: d.ip, rows: [] };
      machines.push(m);
    }
    // An output carrying MACs of two groups says they are one Mac.
    for (const other of bridged) {
      m.rows.push(...other.rows);
      machines = machines.filter((x) => x !== other);
      for (const [mac, owner] of byMac) if (owner === other) byMac.set(mac, m);
    }
    for (const mac of macs) byMac.set(mac, m);
    return m;
  };

  for (const d of seen) {
    if (!d.output) {
      plain.push(d);
      continue;
    }
    const m = machineFor(d);
    // An output whose id names no Mac and which has no MAC cannot be told apart
    // from another Mac's, so it is not grouped: it reads as the plain device it
    // would otherwise have been.
    if (!m) plain.push(d);
    else m.rows.push({ state: "unclaimed", device: d });
  }

  // Siblings already set up join the machines that have something unclaimed.
  // They never start one: a machine of only set-up outputs is not listed.
  for (const b of bound) {
    if (!b.output) continue;
    const id = machineIdOf(b.id);
    const m = id !== undefined ? byId.get(id) : placeByMac(lower(b.macs))[0];
    if (m) m.rows.push({ state: "bound", device: b });
  }

  // `seen` arrives freshest first, which reshuffles on every probe. Sorted, so
  // neither the machines nor the rows under them move while you are reading them.
  for (const m of machines) m.rows.sort(rowOrder);
  machines.sort((a, b) => natural.compare(a.hostname ?? "", b.hostname ?? "") || natural.compare(a.key, b.key));
  return { machines, plain };
}
