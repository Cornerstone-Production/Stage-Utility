// qsys.ts — shapes shared by the Q-SYS server code and the panels that read it.

import { walkLayoutObjects, type LayoutObject, type LayoutObjectConfig, type View } from "./views.js";

/** The objects of panel `panelId` (a View), containers' children included; none when there is no such view. */
function panelObjects(views: View[], panelId: string | null): LayoutObject[] {
  const view = panelId ? views.find((v) => v.id === panelId) : undefined;
  const out: LayoutObject[] = [];
  walkLayoutObjects(view?.layout?.objects ?? [], (o) => out.push(o));
  return out;
}

const bindsTo = (b: QsysAddress | null | undefined, a: QsysAddress): boolean => !!b && b.component === a.component && b.control === a.control;

/**
 * Whether panel `panelId` has a momentary button on `a`: a Q-SYS button bound to
 * it, anywhere in its layout, whose saved `press` is "momentary" (absent is a
 * trigger). The server takes a momentary lease only where this holds, and refuses
 * a press that asks for one anywhere else (`no-lease`), so a client cannot hold a
 * latching control (a toggle, a mute), or a button saved as a trigger, on a lease.
 */
export function panelHasMomentary(views: View[], panelId: string | null, a: QsysAddress): boolean {
  return panelObjects(views, panelId).some((o) => o.config.type === "qsys-button" && o.config.press === "momentary" && bindsTo(o.config.binding, a));
}

/**
 * Whether panel `panelId` has a selector whose choice list is `a`. Only such a
 * write is held to the choices the Core lists: a mute or a switch on a Boolean
 * that also reports choices writes true and false as any Boolean does.
 */
export function panelHasSelectorOn(views: View[], panelId: string | null, a: QsysAddress): boolean {
  return panelObjects(views, panelId).some((o) => o.config.type === "qsys-selector" && bindsTo(o.config.binding, a));
}

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
  /** A combo box's list, when the Core reports one. */
  Choices?: unknown;
}

/** The choices a control reports (text, non-empty), or null. Choices bound what may be written to it. */
export function choicesOf(c: QsysControlFacts): string[] | null {
  if (!Array.isArray(c.Choices)) return null;
  const list = c.Choices.filter((x): x is string => typeof x === "string");
  return list.length > 0 ? list : null;
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
 * no range. `viaChoices`: the writer is a selector picking from the choices the
 * control reports, which bound it instead of a range (a numeric-typed combo box
 * needs none then; a fader on the same control still does). The one rule for "is
 * this writable"; the writer refuses on it before sending, and anything that asks
 * the same question asks here.
 */
export function unwritableReason(c: QsysControlFacts, entry: { min: number | null; max: number | null }, viaChoices = false): "read-only" | "no-range" | null {
  if (isReadOnlyDirection(c.Direction)) return "read-only";
  if (kindOf(c) === "number" && !(viaChoices && choicesOf(c)) && (entry.min === null || entry.max === null)) return "no-range";
  return null;
}

export function isWritable(c: QsysControlFacts, entry: { min: number | null; max: number | null }, viaChoices = false): boolean {
  return unwritableReason(c, entry, viaChoices) === null;
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

/** A binding's own control, without its indicator: what is read or written. */
export const addressOf = (b: QsysAddress): QsysAddress => ({ component: b.component, control: b.control });

/** Whether an object writes a binding's control, or only reads it. An indicator is always only read. */
export type QsysSlotRole = "write" | "read";
export type QsysSlot = {
  binding: QsysBinding | null | undefined;
  role: QsysSlotRole;
  /** A selector's choice list: written with one of the choices the Core reports, so bound by them rather than a range. */
  viaChoices?: true;
};

const slots = (role: QsysSlotRole, ...bindings: (QsysBinding | null | undefined)[]): QsysSlot[] => bindings.map((binding) => ({ binding, role }));

/**
 * Each binding a layout object holds, in field order, and whether the object
 * writes it. The one table of what each Q-SYS object binds: the watch's addresses
 * (qsysAddressesOf) and the binding check both read it, so a binding cannot be
 * watched but not checked, or the reverse. Not a Q-SYS object: none.
 */
export function slotsOf(config: LayoutObjectConfig): QsysSlot[] {
  switch (config.type) {
    case "qsys-fader":
    case "qsys-mute":
    case "qsys-button":
      return slots("write", config.binding);
    case "qsys-label":
      return slots("read", config.binding);
    case "qsys-meter":
      return slots("read", config.binding, config.binding2);
    case "qsys-switch":
      return slots("write", config.binding, config.onBinding, config.offBinding);
    case "qsys-presets":
      return slots("write", ...config.items.map((i) => i.binding), config.previous);
    case "qsys-selector":
      return [{ binding: config.binding, role: "write", viaChoices: true }, ...slots("write", ...config.items.map((i) => i.binding))];
    case "qsys-strip":
      return [...slots("read", config.name), ...slots("write", config.gain, config.mute), ...slots("read", config.meter, config.meter2)];
    default:
      return [];
  }
}

/** Every control a layout object reads, in field order with a binding's indicator
 *  right after it, each address once. Null and absent bindings read nothing, and an
 *  object that is not a Q-SYS object reads nothing. The panel list and the watch set
 *  are built from this, so a binding an object holds but this misses is never watched. */
export function qsysAddressesOf(config: LayoutObjectConfig): QsysAddress[] {
  const seen = new Set<string>();
  const out: QsysAddress[] = [];
  for (const { binding } of slotsOf(config)) {
    if (!binding) continue;
    for (const addr of binding.indicator ? [addressOf(binding), addressOf(binding.indicator)] : [addressOf(binding)]) {
      const k = addressKey(addr);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(addr);
    }
  }
  return out;
}

// ── Panels ─────────────────────────────────────────────────────────────────

/**
 * What makes a console View a Q-SYS panel: who it is for, the URL it opens at
 * (`/qsys/<slug>`), the panels its cog menu lists, and how long it waits without
 * a touch before going back to the device's home panel.
 */
export interface QsysPanelBlock {
  kind: PanelKind;
  /** Lowercase a-z, 0-9 and single hyphens; unique across the views; never "manage". */
  slug: string;
  /** Other panels' slugs, for the cog menu. One that does not exist is kept and
   *  dropped from the menu where it is drawn, never refused here. */
  siblings: string[];
  /** Minutes without a touch before returning home; 0 never returns. */
  returnAfterMin: number;
}

export const QSYS_SLUG_MAX = 64;
export const QSYS_RETURN_DEFAULT_MIN = 5;
export const QSYS_RETURN_MAX_MIN = 1440;
const QSYS_SIBLINGS_MAX = 50;
/** `/qsys/manage` is the operator's page, so no panel may take its name. */
const RESERVED_QSYS_SLUGS: ReadonlySet<string> = new Set(["manage"]);
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Is this a slug a panel may have? Shape only; uniqueness is {@link qsysSlugOwner}'s. */
export function isQsysSlug(v: unknown): v is string {
  return typeof v === "string" && v.length <= QSYS_SLUG_MAX && SLUG_SHAPE.test(v) && !RESERVED_QSYS_SLUGS.has(v);
}

/** A panel's name as a slug: lowercase, every run of anything else one hyphen.
 *  "panel" for a name with nothing left, and a reserved word gets "-panel". */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, QSYS_SLUG_MAX)
    .replace(/-+$/, "");
  if (!base) return "panel";
  return RESERVED_QSYS_SLUGS.has(base) ? `${base}-panel` : base;
}

/** `base`, or `base-2`, `base-3`... : the first that is not in `taken`. */
export function uniqueQsysSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const slug = `${base.slice(0, QSYS_SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(slug)) return slug;
  }
}

/** Every slug the views' panels use. */
export function qsysSlugsOf(views: readonly { qsys?: QsysPanelBlock | null }[]): Set<string> {
  return new Set(views.flatMap((v) => (v.qsys ? [v.qsys.slug] : [])));
}

/** The kind a view's Q-SYS objects poll their meters as: its panel block's, else
 *  staff (a console with Q-SYS objects and no block, or no view at all). The
 *  server's watch and every page ask here, so they name the same meter channel. */
export function panelKindOf(view: { qsys?: QsysPanelBlock | null } | null | undefined): PanelKind {
  return view?.qsys?.kind ?? "staff";
}

/** Is this View a Q-SYS panel: one with a `qsys` block. */
export function isQsysPanel(v: { qsys?: QsysPanelBlock | null }): boolean {
  return !!v.qsys;
}

/** The panel at `/qsys/<slug>`, or null. The first in view order if two ever share one. */
export function findPanelBySlug<V extends { qsys?: QsysPanelBlock | null }>(views: readonly V[], slug: string): V | null {
  return views.find((v) => v.qsys?.slug === slug) ?? null;
}

/** The view, other than `exceptId`, already using `slug`; null when it is free. */
export function qsysSlugOwner<V extends { id: string; qsys?: QsysPanelBlock | null }>(views: readonly V[], slug: string, exceptId: string | null): V | null {
  return views.find((v) => v.id !== exceptId && v.qsys?.slug === slug) ?? null;
}

/**
 * A `qsys` block as a request or a file gives it, checked: the block, or why it is
 * refused. `siblings` defaults to none and `returnAfterMin` to 5. Shape only:
 * whether the slug is free is decided against the views at the write.
 */
export function parseQsysPanelBlock(raw: unknown): { block: QsysPanelBlock } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "qsys must be an object or null" };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== "kind" && k !== "slug" && k !== "siblings" && k !== "returnAfterMin") return { error: `qsys has a field this app does not have: ${k.slice(0, 40)}` };
  }
  if (r.kind !== "volunteer" && r.kind !== "staff") return { error: "qsys.kind must be volunteer or staff" };
  if (!isQsysSlug(r.slug)) {
    return { error: `qsys.slug must be lowercase letters, digits and single hyphens, up to ${QSYS_SLUG_MAX} characters, and not "manage"` };
  }
  const siblings = r.siblings ?? [];
  if (!Array.isArray(siblings) || siblings.length > QSYS_SIBLINGS_MAX || !siblings.every(isQsysSlug)) {
    return { error: `qsys.siblings must be a list of up to ${QSYS_SIBLINGS_MAX} panel slugs` };
  }
  const unique = [...new Set(siblings as string[])].filter((s) => s !== r.slug);
  const returnAfterMin = r.returnAfterMin ?? QSYS_RETURN_DEFAULT_MIN;
  if (typeof returnAfterMin !== "number" || !Number.isInteger(returnAfterMin) || returnAfterMin < 0 || returnAfterMin > QSYS_RETURN_MAX_MIN) {
    return { error: `qsys.returnAfterMin must be a whole number of minutes from 0 to ${QSYS_RETURN_MAX_MIN}` };
  }
  return { block: { kind: r.kind, slug: r.slug, siblings: unique, returnAfterMin } };
}

/** What a duplicate slug is refused with. */
export function slugTakenMessage(slug: string, owner: { name: string }): string {
  return `the panel address /qsys/${slug} is already used by "${owner.name}"; pick another`;
}

/**
 * The panels a panel's cog menu lists, and the siblings it names that no panel
 * has. A missing one is not an error: it is dropped from the menu where the menu
 * is drawn, and /qsys/manage lists it so somebody can fix the list. The one place
 * that decides which is which.
 */
export function siblingsOf<V extends { qsys?: QsysPanelBlock | null }>(
  panel: { qsys?: QsysPanelBlock | null },
  views: readonly V[],
): { present: V[]; missing: string[] } {
  const present: V[] = [];
  const missing: string[] = [];
  for (const slug of panel.qsys?.siblings ?? []) {
    const found = findPanelBySlug(views, slug);
    if (found && found.qsys?.slug !== panel.qsys?.slug) present.push(found);
    else if (!found) missing.push(slug);
  }
  return { present, missing };
}
