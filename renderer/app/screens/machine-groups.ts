// Which devices on Screens are outputs of one Mac, and so are shown as one
// machine rather than as look-alikes.
//
// The Mac output helper announces one device per output, all with the Mac's MAC
// addresses and hostname. Every one that is still unclaimed is a row under the
// Mac's header, and every sibling already set up is a dimmed row beside them, so
// "SDI 1 is Main stage left" reads next to "SDI 2 is not set up". A device with no
// `output` is not grouped with anything and keeps the list it has always had.

import type { SeenDevice } from "@main/types/kiosk";
import type { PublicDevice } from "@main/services/kiosk-devices-store";

export type MachineRow =
  | { state: "unclaimed"; device: SeenDevice }
  | { state: "bound"; device: PublicDevice };

export interface Machine {
  /** The first MAC the group was found by, for a React key. */
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
 * Split what Screens has heard into machines and plain devices.
 *
 * Devices belong to the same machine when they share a MAC address. A machine is
 * listed only while at least one of its outputs is not set up: a Mac whose every
 * output has a screen has nothing left to offer here, and the screens themselves
 * say where they are.
 */
export function groupByMachine(seen: readonly SeenDevice[], bound: readonly PublicDevice[]): Grouped {
  const plain: SeenDevice[] = [];
  const machines: Machine[] = [];
  // MAC -> the machine it belongs to, so a device carrying any MAC of a known
  // machine joins it.
  const byMac = new Map<string, Machine>();

  const lower = (macs: readonly string[]) => macs.map((m) => m.toLowerCase());
  const known = (macs: readonly string[]) => macs.map((x) => byMac.get(x)).find((x): x is Machine => !!x);

  const machineFor = (d: SeenDevice): Machine | undefined => {
    const macs = lower(d.macs);
    if (macs.length === 0) return undefined;
    let m = known(macs);
    if (!m) {
      m = { key: macs[0], hostname: d.hostname, os: d.os, ip: d.ip, rows: [] };
      machines.push(m);
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
    // An output with no MAC cannot be told apart from another Mac's, so it is
    // not grouped: it reads as the plain device it would otherwise have been.
    if (!m) plain.push(d);
    else m.rows.push({ state: "unclaimed", device: d });
  }

  // Siblings already set up join the machines that have something unclaimed.
  // They never start one: a machine of only set-up outputs is not listed.
  for (const b of bound) {
    if (!b.output) continue;
    const m = known(lower(b.macs));
    if (m) m.rows.push({ state: "bound", device: b });
  }

  // `seen` arrives freshest first, which reshuffles on every probe. Sorted, so
  // neither the machines nor the rows under them move while you are reading them.
  for (const m of machines) m.rows.sort(rowOrder);
  machines.sort((a, b) => natural.compare(a.hostname ?? "", b.hostname ?? "") || natural.compare(a.key, b.key));
  return { machines, plain };
}
