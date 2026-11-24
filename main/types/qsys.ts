// qsys.ts — shapes shared by the Q-SYS server code and the panels that read it.

import type { LayoutObjectConfig } from "./views.js";

/** One control on the Core: a component's Code Name and the control's name. */
export type QsysAddress = { component: string; control: string };

/** What a layout object stores: the control it reads or writes, and optionally a
 *  separate control that says whether it is lit (a snapshot Match, an LED). */
export type QsysBinding = QsysAddress & { indicator?: QsysAddress | null };

/** How tightly a fader or channel strip is drawn: standard (the volunteer panel's
 *  92 px strip) or dense (the staff panel's 80 px strip with a dB tick scale). */
export type QsysDensity = "standard" | "dense";

/** A volunteer panel's meters poll at the volunteer rate, a staff panel's at the staff rate. */
export type PanelKind = "volunteer" | "staff";

/**
 * A control the Core reports as read-only (QRC `Direction: "Read"`). The one rule
 * for it: the writer refuses such a control before sending, and a panel draws an
 * object that writes it as Unavailable.
 */
export function isReadOnlyDirection(direction: unknown): boolean {
  return /^read$/i.test(String(direction ?? "").trim());
}

/** A map key for an address. NUL cannot appear in a Code Name or a control name. */
export function addressKey(a: QsysAddress): string {
  return `${a.component}\u0000${a.control}`;
}

/** The address a key was made from: the inverse of addressKey. */
export function parseAddressKey(k: string): QsysAddress {
  const i = k.indexOf("\u0000");
  return { component: k.slice(0, i), control: k.slice(i + 1) };
}

const own = (b: QsysBinding | null | undefined): QsysAddress[] => {
  if (!b) return [];
  const out: QsysAddress[] = [{ component: b.component, control: b.control }];
  if (b.indicator) out.push({ component: b.indicator.component, control: b.indicator.control });
  return out;
};

/** Every control a layout object reads, in field order with a binding's indicator
 *  right after it, each address once. Null and absent bindings read nothing, and an
 *  object that is not a Q-SYS object reads nothing. The panel list and the watch set
 *  are built from this, so a binding an object holds but this misses is never watched. */
export function qsysAddressesOf(config: LayoutObjectConfig): QsysAddress[] {
  let bindings: (QsysBinding | null | undefined)[];
  switch (config.type) {
    case "qsys-fader":
    case "qsys-mute":
    case "qsys-button":
    case "qsys-label":
      bindings = [config.binding];
      break;
    case "qsys-meter":
      bindings = [config.binding, config.binding2];
      break;
    case "qsys-switch":
      bindings = [config.binding, config.onBinding, config.offBinding];
      break;
    case "qsys-presets":
      bindings = [...config.items.map((i) => i.binding), config.previous];
      break;
    case "qsys-selector":
      bindings = [config.binding, ...config.items.map((i) => i.binding)];
      break;
    case "qsys-strip":
      bindings = [config.name, config.gain, config.mute, config.meter, config.meter2];
      break;
    default:
      return [];
  }
  const seen = new Set<string>();
  const out: QsysAddress[] = [];
  for (const addr of bindings.flatMap(own)) {
    const k = addressKey(addr);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(addr);
  }
  return out;
}
