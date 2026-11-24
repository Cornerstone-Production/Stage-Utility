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

/** The parts of a QRC control the rules below read. */
export interface QsysControlFacts {
  Type?: unknown;
  Value?: unknown;
  Direction?: unknown;
}

export type QsysControlKind = "boolean" | "trigger" | "text" | "number";

/**
 * Which rules a control's writes follow. Fails closed: anything not positively a
 * boolean, trigger or text control is numeric, so it is range-checked. The Type
 * strings the Core reports are on the spec's "verify in Emulate" list; the
 * value's own type backs them up. The writer and the editor's Core browser both ask here.
 */
export function kindOf(c: QsysControlFacts): QsysControlKind {
  const type = String(c.Type ?? "");
  if (/^bool/i.test(type) || typeof c.Value === "boolean") return "boolean";
  if (/^trigger/i.test(type)) return "trigger";
  if (/^(text|string)$/i.test(type)) return "text";
  return "number";
}

/**
 * Why `c` cannot be written under an allowlist entry whatever the value, or null
 * when it can: the Core reports it read-only, or it is numeric and the entry sets
 * no range. The one rule for "is this writable"; the writer refuses on it before
 * sending, and anything that asks the same question asks here.
 */
export function unwritableReason(c: QsysControlFacts, entry: { min: number | null; max: number | null }): "read-only" | "no-range" | null {
  if (isReadOnlyDirection(c.Direction)) return "read-only";
  if (kindOf(c) === "number" && (entry.min === null || entry.max === null)) return "no-range";
  return null;
}

export function isWritable(c: QsysControlFacts, entry: { min: number | null; max: number | null }): boolean {
  return unwritableReason(c, entry) === null;
}

/**
 * A meter: a control on a meter component (meter2 and kin), or a control named
 * `meter...`. Which component types the Core reports for meters is one of the
 * spec's "verify in Emulate" items; the name rule covers meter2's `meter_1`.
 */
export function isMeterControl(componentType: string, control: { Name: string; Type: string }): boolean {
  return /^meter/i.test(componentType) || /^meter/i.test(control.Name) || /^meter/i.test(control.Type);
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
