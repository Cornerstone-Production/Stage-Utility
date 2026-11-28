// qsys-strip.ts — the channel strip's two editor actions, as pure functions.
//
// One-step bind: pick a component and a channel, and the strip's fields are filled
// from the controls whose names follow a Core's convention for that channel
// (input.3.gain, input.3.mute, input.3.label, meter.3, text.display.3, or
// output.N.*). Break
// apart: replace the strip with separate label, fader, meter and mute objects in
// the same footprint, keeping every binding.
//
// A write slot (level, mute) is only filled with a control the caller says is
// eligible, which is the Core browser's rule: allowlisted and writable. A slot
// with no eligible match stays empty and says why. The operator can change any
// field afterwards.

import type { QsysBinding } from "@main/types/qsys";
import type { LayoutObject, LayoutObjectConfig } from "@main/types/views";

export type StripSlot = "gain" | "meter" | "meter2" | "mute" | "name";
export type ChannelSide = "" | "input" | "output";
export interface StripChannel {
  /** "" for a channel named by number alone (meter.3). */
  side: ChannelSide;
  n: number;
}

/**
 * The control names a slot is looked for under, per channel, as a Core names a
 * mixer's controls: dots between the parts (`input.3.gain`, `output.1.mute`,
 * `text.display.3`). `{s}` is the side (input or output) and `{n}` the channel
 * number. A sided template is tried before an unsided one; a template with `{s}`
 * is skipped for a channel that has no side. A crosspoint (`input.1.output.2.gain`)
 * is no channel's. A meter name must also be one the Core browser's meter rule
 * accepts (it starts with "meter"), so the one-step fill and the Meter field offer
 * the same controls. A Core's meters usually sit on their own meter2 component, so
 * on a mixer the meter slots mostly stay empty. One table, one template per line,
 * sorted by slot and then template; no template fills the second meter.
 */
export const STRIP_TEMPLATES: { slot: StripSlot; template: string }[] = [
  { slot: "gain", template: "{s}.{n}.gain" },
  { slot: "meter", template: "meter.{n}" },
  { slot: "mute", template: "{s}.{n}.mute" },
  { slot: "name", template: "text.display.{n}" },
  { slot: "name", template: "{s}.{n}.label" },
];

const nameFor = (template: string, c: StripChannel): string | null => {
  if (template.includes("{s}") && !c.side) return null;
  return template.replace("{s}", c.side).replace("{n}", String(c.n));
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS = STRIP_TEMPLATES.map(({ template }) => ({
  sided: template.includes("{s}"),
  re: new RegExp(`^${escape(template).replace("\\{s\\}", "(input|output)").replace("\\{n\\}", "(\\d+)")}$`),
}));

/** The channels a component's control names point at, sided ones first, each by number. */
export function channelsOf(names: readonly string[]): StripChannel[] {
  const seen = new Map<string, StripChannel>();
  for (const name of names) {
    for (const { sided, re } of PATTERNS) {
      const m = re.exec(name);
      if (!m) continue;
      const c: StripChannel = sided ? { side: m[1] as ChannelSide, n: Number(m[2]) } : { side: "", n: Number(m[1]) };
      seen.set(`${c.side}\u0000${c.n}`, c);
      break;
    }
  }
  // An unsided channel the sided ones already cover (meter.3 beside input.3.gain) is the same channel.
  const out = [...seen.values()];
  const sidedNs = new Set(out.filter((c) => c.side).map((c) => c.n));
  return out
    .filter((c) => c.side || !sidedNs.has(c.n))
    .sort((a, b) => (a.side || "~").localeCompare(b.side || "~") || a.n - b.n);
}

export const channelLabel = (c: StripChannel): string => (c.side ? `${c.side[0]!.toUpperCase()}${c.side.slice(1)} ${c.n}` : `Channel ${c.n}`);

/**
 * A Gain block (component type `gain`) is one channel with no number: its level is the
 * control `gain` and its mute the control `mute`. It has no meter or name of its own.
 */
export const isGainBlock = (componentType: string, names: readonly string[]): boolean => /^gain$/i.test(componentType) && names.includes("gain");

/** Why a slot stayed empty. */
export type SlotProblem = "missing" | "not-allowed" | "not-writable" | "wrong-kind";
export interface SlotMatch {
  control: string | null;
  problem: SlotProblem | null;
}

/**
 * What decides whether a control may fill a slot: the caller's answer for a control
 * named for it. "ok", or the reason it may not.
 */
export type Eligibility = (slot: StripSlot, control: string) => "ok" | Exclude<SlotProblem, "missing">;

/**
 * The strip's fields for `channel`, from a component's control names. The first
 * template that names an existing control and is eligible wins; if some named
 * control exists but none is eligible the slot is empty with that control's reason,
 * and with none at all it is empty and `missing`.
 */
export function matchStrip(names: readonly string[], channel: StripChannel, eligible: Eligibility): Record<StripSlot, SlotMatch> {
  const have = new Set(names);
  const out = {} as Record<StripSlot, SlotMatch>;
  for (const slot of ["gain", "meter", "meter2", "mute", "name"] as StripSlot[]) {
    const candidates = STRIP_TEMPLATES.filter((t) => t.slot === slot)
      .map((t) => ({ sided: t.template.includes("{s}"), name: nameFor(t.template, channel) }))
      .filter((c): c is { sided: boolean; name: string } => !!c.name && have.has(c.name))
      .sort((a, b) => Number(b.sided) - Number(a.sided));
    let problem: SlotProblem = "missing";
    out[slot] = { control: null, problem };
    for (const c of candidates) {
      const verdict = eligible(slot, c.name);
      if (verdict === "ok") {
        out[slot] = { control: c.name, problem: null };
        break;
      }
      if (problem === "missing") problem = verdict;
      out[slot] = { control: null, problem };
    }
  }
  return out;
}

/** The strip's fields for a Gain block: level from `gain`, mute from `mute`, the rest empty. The same eligibility rule as matchStrip. */
export function matchGainBlock(names: readonly string[], eligible: Eligibility): Record<StripSlot, SlotMatch> {
  const have = new Set(names);
  const slot = (s: StripSlot, control: string): SlotMatch => {
    if (!have.has(control)) return { control: null, problem: "missing" };
    const verdict = eligible(s, control);
    return verdict === "ok" ? { control, problem: null } : { control: null, problem: verdict };
  };
  const none: SlotMatch = { control: null, problem: "missing" };
  return { gain: slot("gain", "gain"), mute: slot("mute", "mute"), meter: none, meter2: none, name: none };
}

/** A slot's emptiness, in words for the inspector. */
export function problemWords(slot: StripSlot, p: SlotProblem): string {
  const what = { gain: "level", meter: "meter", meter2: "second meter", mute: "mute", name: "name" }[slot];
  switch (p) {
    case "missing":
      return `No ${what} control found for this channel.`;
    case "not-allowed":
      return `The ${what} control is not on the allowlist.`;
    case "not-writable":
      return `The ${what} control is read-only or has no write limits.`;
    case "wrong-kind":
      return `The ${what} control is not the right kind.`;
  }
}

type Strip = Extract<LayoutObjectConfig, { type: "qsys-strip" }>;

/**
 * The strip as separate objects in the same footprint: its name over a fader with
 * its meter or meters beside it, mute underneath. Every binding and the density
 * carry over; a part the strip had nothing for is left out. The style is the strip's.
 */
export function breakApartStrip(o: LayoutObject, newId: () => string, canvasAspect = 16 / 9): LayoutObject[] {
  const c = o.config as Strip;
  // Per part. keepAspect, minPx and maxPx describe the strip's proportions, which no part
  // has, so none gets them; anchor pins an edge of the whole strip, which every part still
  // shares, so each keeps it. The label draws its text at the object's own font size (the
  // strip drew its title at 0.6 of it), so it is sized to read on one line across the
  // strip's width, about ten characters at 0.7 em each plus the label's padding, with room to spare
  // for a canvas shown at a different shape; the others scale from theirs. A longer name still ends in an ellipsis.
  const { keepAspect: _a, minPx: _b, maxPx: _c, ...shared } = o;
  const stripFont = o.style?.fontSize ?? 0.05;
  const labelFont = Math.max(0.012, Math.min(stripFont * 0.6, (o.w * canvasAspect) / 9));
  const part = (config: LayoutObjectConfig, x: number, y: number, w: number, h: number): LayoutObject => ({
    ...shared,
    id: newId(),
    children: undefined,
    x: o.x + o.w * x,
    y: o.y + o.h * y,
    w: o.w * w,
    h: o.h * h,
    config,
  });
  const hasName = !!c.name || !!c.label.trim();
  const hasMute = !!c.mute;
  const top = hasName ? 0.12 : 0;
  const bottom = hasMute ? 0.12 : 0;
  const bodyH = 1 - top - bottom;
  const meters = !!(c.meter || c.meter2);
  const out: LayoutObject[] = [];
  if (hasName) {
    const label = part({ type: "qsys-label", binding: c.name, text: c.label }, 0, 0, 1, top);
    out.push({ ...label, style: { ...o.style, fontSize: labelFont } });
  }
  if (c.gain) {
    out.push(
      part(
        { type: "qsys-fader", binding: c.gain, orientation: "vertical", showDb: true, steps: false, stepDb: 1, ...(c.density ? { density: c.density } : {}) },
        0,
        top,
        meters ? 0.7 : 1,
        bodyH,
      ),
    );
  }
  if (meters) {
    out.push(part({ type: "qsys-meter", binding: c.meter ?? c.meter2 ?? null, ...(c.meter && c.meter2 ? { binding2: c.meter2 } : {}), form: "bar" }, c.gain ? 0.7 : 0, top, c.gain ? 0.3 : 1, bodyH));
  }
  if (hasMute) out.push(part({ type: "qsys-mute", binding: c.mute as QsysBinding }, 0, 1 - bottom, 1, bottom));
  return out;
}
