// rosstalk-commands.ts — the RossTalk command catalogue.
//
// Pure data and pure formatters: no sockets, no state. This is the ONLY place
// command syntax lives, which is what lets the two device families coexist safely.
//
// Every command belongs to exactly ONE family. Carbonite and Ultrix both have XPT
// and GPI, but XPT has different syntax on each and GPI means different things
// (a GPI output vs a salvo), so they are separate entries rather than one
// branching formatter. See docs/superpowers/specs/2026-07-26-rosstalk-design.md.
//
// Verified against Ross's published docs:
//   https://help.rossvideo.com/carbonite-device/Topics/Protocol/RossTalk/CNT/RT-CNT-Comm.html
//   https://help.rossvideo.com/carbonite-device/Topics/Protocol/RossTalk/UT/RT-UT-Comm.html

import type { RossTalkCommand, RossTalkFamily, RossTalkParam } from "../types/rosstalk.js";

/** ME source values Carbonite accepts. Ultra names its MEs differently (ME 2, ME 1, P/P). */
const ME_SOURCES = ["ME", "MEM", "PP"];

const num = (key: string, label: string, extra: Partial<RossTalkParam> = {}): RossTalkParam => ({
  key, label, type: "number", ...extra,
});
const str = (key: string, label: string, extra: Partial<RossTalkParam> = {}): RossTalkParam => ({
  key, label, type: "string", ...extra,
});
const en = (key: string, label: string, options: string[], extra: Partial<RossTalkParam> = {}): RossTalkParam => ({
  key, label, type: "enum", options, ...extra,
});

/** Validate one value against its param spec and return it wire-ready. */
function coerce(p: RossTalkParam, raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") {
    if (p.optional) return null;
    throw new Error(`Missing required parameter "${p.key}"`);
  }
  if (p.type === "number") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) throw new Error(`Parameter "${p.key}" must be a number`);
    if (p.min !== undefined && n < p.min) throw new Error(`Parameter "${p.key}" out of range (${p.min}-${p.max})`);
    if (p.max !== undefined && n > p.max) throw new Error(`Parameter "${p.key}" out of range (${p.min}-${p.max})`);
    return p.pad ? String(n).padStart(p.pad, "0") : String(n);
  }
  const s = String(raw).trim();
  if (p.type === "enum" && p.options && !p.options.includes(s)) {
    throw new Error(`Parameter "${p.key}" must be one of: ${p.options.join(", ")}`);
  }
  return s;
}

/** Coerce every declared param, returning a lookup of wire-ready strings. */
function values(cmd: RossTalkCommand, input: Record<string, string | number>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of cmd.params) out[p.key] = coerce(p, input[p.key]);
  return out;
}

const ME = [en("meSource", "ME source", ME_SOURCES), num("meNumber", "ME number", { min: 0, max: 9 })];

function def(c: RossTalkCommand): RossTalkCommand {
  return c;
}

export const ROSSTALK_COMMANDS: Record<string, RossTalkCommand> = {
  // ── Carbonite ──────────────────────────────────────────────────────────────
  cc: def({
    id: "cc",
    label: "Custom control",
    family: "carbonite",
    help: "Fires a custom control macro on the switcher.",
    params: [num("bank", "Bank", { min: 1, max: 9 }), num("cc", "Custom control", { min: 1, max: 99, pad: 2 })],
    format: (v) => { const p = values(ROSSTALK_COMMANDS.cc, v); return `CC ${p.bank}:${p.cc}`; },
  }),
  "gpi-carbonite": def({
    id: "gpi-carbonite",
    label: "Trigger GPI output",
    family: "carbonite",
    params: [num("gpi", "GPI", { min: 1, max: 99, pad: 2 })],
    format: (v) => `GPI ${values(ROSSTALK_COMMANDS["gpi-carbonite"], v).gpi}`,
  }),
  ftb: def({
    id: "ftb",
    label: "Fade to black",
    family: "carbonite",
    params: [],
    format: () => "FTB",
  }),
  mecut: def({
    id: "mecut",
    label: "ME cut",
    family: "carbonite",
    params: ME,
    format: (v) => { const p = values(ROSSTALK_COMMANDS.mecut, v); return `MECUT ${p.meSource}:${p.meNumber}`; },
  }),
  meauto: def({
    id: "meauto",
    label: "ME auto transition",
    family: "carbonite",
    params: ME,
    format: (v) => { const p = values(ROSSTALK_COMMANDS.meauto, v); return `MEAUTO ${p.meSource}:${p.meNumber}`; },
  }),
  keycut: def({
    id: "keycut",
    label: "Key cut",
    family: "carbonite",
    params: [...ME, num("keyer", "Keyer", { min: 1, max: 8 }), en("state", "State", ["ON", "OFF"], { optional: true })],
    format: (v) => {
      const p = values(ROSSTALK_COMMANDS.keycut, v);
      return `KEYCUT ${p.meSource}:${p.meNumber}:${p.keyer}` + (p.state ? `:${p.state}` : "");
    },
  }),
  keyauto: def({
    id: "keyauto",
    label: "Key auto transition",
    family: "carbonite",
    params: [...ME, num("keyer", "Keyer", { min: 1, max: 8 }), en("state", "State", ["ON", "OFF"], { optional: true })],
    format: (v) => {
      const p = values(ROSSTALK_COMMANDS.keyauto, v);
      return `KEYAUTO ${p.meSource}:${p.meNumber}:${p.keyer}` + (p.state ? `:${p.state}` : "");
    },
  }),
  mem: def({
    id: "mem",
    label: "Memory recall",
    family: "carbonite",
    params: [num("bank", "Bank", { min: 0, max: 9 }), num("memory", "Memory", { min: 0, max: 9 }), ...ME],
    format: (v) => {
      const p = values(ROSSTALK_COMMANDS.mem, v);
      return `MEM ${p.bank}:${p.memory}:${p.meSource}:${p.meNumber}`;
    },
  }),
  memsave: def({
    id: "memsave",
    label: "Memory save",
    family: "carbonite",
    params: [num("bank", "Bank", { min: 0, max: 9 }), num("memory", "Memory", { min: 0, max: 9 }), ...ME],
    format: (v) => {
      const p = values(ROSSTALK_COMMANDS.memsave, v);
      return `MEMSAVE ${p.bank}:${p.memory}:${p.meSource}:${p.meNumber}`;
    },
  }),
  transrate: def({
    id: "transrate",
    label: "Transition rate",
    family: "carbonite",
    params: [...ME, num("rate", "Rate (frames)", { min: 0, max: 999 })],
    format: (v) => {
      const p = values(ROSSTALK_COMMANDS.transrate, v);
      return `TRANSRATE ${p.meSource}:${p.meNumber}:${p.rate}`;
    },
  }),
  transtype: def({
    id: "transtype",
    label: "Transition type",
    family: "carbonite",
    params: [...ME, str("type", "Type", { help: "e.g. DISS, WIPE" })],
    format: (v) => {
      const p = values(ROSSTALK_COMMANDS.transtype, v);
      return `TRANSTYPE ${p.meSource}:${p.meNumber}:${p.type}`;
    },
  }),
  "xpt-carbonite": def({
    id: "xpt-carbonite",
    label: "Crosspoint",
    family: "carbonite",
    params: [num("dest", "Destination", { min: 0, max: 999 }), num("source", "Source", { min: 0, max: 999 })],
    format: (v) => {
      const p = values(ROSSTALK_COMMANDS["xpt-carbonite"], v);
      return `XPT ${p.dest}:${p.source}`;
    },
  }),
  clipload: def({
    id: "clipload",
    label: "Load clip",
    family: "carbonite",
    params: [str("clip", "Clip name")],
    format: (v) => `CLIPLOAD ${values(ROSSTALK_COMMANDS.clipload, v).clip}`,
  }),
  seqi: def({
    id: "seqi",
    label: "Sequencer load",
    family: "carbonite",
    params: [num("sequencer", "Sequencer", { min: 0, max: 99 }), num("seq", "Sequence", { min: 0, max: 999 })],
    format: (v) => {
      const p = values(ROSSTALK_COMMANDS.seqi, v);
      return `SEQI ${p.sequencer}:${p.seq}`;
    },
  }),

  // ── Ultrix ─────────────────────────────────────────────────────────────────
  "xpt-ultrix": def({
    id: "xpt-ultrix",
    label: "Route crosspoint",
    family: "ultrix",
    help: "Routes a source to a destination. Levels are optional.",
    params: [
      num("dest", "Destination", { min: 0, max: 9999 }),
      num("source", "Source", { min: 0, max: 9999 }),
      num("userId", "User / panel id", { min: 0, max: 999 }),
      str("levels", "Levels", { optional: true, help: "e.g. 1,6,10-13" }),
    ],
    format: (v) => {
      const p = values(ROSSTALK_COMMANDS["xpt-ultrix"], v);
      // Trailing space would be sent verbatim, so only append levels when present.
      return `XPT D:${p.dest} S:${p.source} I:${p.userId}` + (p.levels ? ` L:${p.levels}` : "");
    },
  }),
  "gpi-ultrix": def({
    id: "gpi-ultrix",
    label: "Fire salvo",
    family: "ultrix",
    help: "On Ultrix, GPI fires a salvo rather than a GPI output.",
    params: [num("salvo", "Salvo", { min: 0, max: 999 })],
    format: (v) => `GPI ${values(ROSSTALK_COMMANDS["gpi-ultrix"], v).salvo}`,
  }),
  timer: def({
    id: "timer",
    label: "Clock control",
    family: "ultrix",
    params: [num("clock", "Clock", { min: 0, max: 99 }), en("action", "Action", ["RUN", "STOP", "PAUSE", "END"])],
    format: (v) => {
      const p = values(ROSSTALK_COMMANDS.timer, v);
      return `TIMER ${p.clock}:${p.action}`;
    },
  }),
};

export function commandsForFamily(family: RossTalkFamily): RossTalkCommand[] {
  return Object.values(ROSSTALK_COMMANDS).filter((c) => c.family === family);
}

/** Format a command by id. Throws with a human reason on any validation failure —
 *  the device never replies, so this is the only place a mistake can surface. */
export function formatCommand(id: string, input: Record<string, string | number>): string {
  const cmd = ROSSTALK_COMMANDS[id];
  if (!cmd) throw new Error(`RossTalk: unknown command "${id}"`);
  return cmd.format(input);
}

/**
 * Make a raw operator-supplied line safe to send. CR/LF are stripped so one raw
 * entry can never smuggle a second command onto the wire.
 */
export function sanitiseRaw(raw: string): string {
  const line = String(raw).replace(/[\r\n]/g, "").trim();
  if (!line) throw new Error("RossTalk: raw command is empty");
  return line;
}
