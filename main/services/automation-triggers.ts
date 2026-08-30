// automation-triggers.ts — the trigger registry.
//
// PURE: no I/O, no wall-clock reads beyond the `now` passed in. Every entry turns a
// pair of state SNAPSHOTS into a yes/no "did this fire", which is what converts the
// broadcaster's constantly-repeated state into edges.
//
// THE CONTRACT: didFire MUST return false when `prev` is null. On startup the engine
// has no previous snapshot; treating that as a transition would fire every rule at
// once after an update or crash mid-service, unattended. Asserted for every trigger
// in automation-triggers.test.ts.

import type { ParamDef, TriggerDef } from "../types/automation.js";
import { dueAt } from "./automation-due-time.js";
import { findItemByTitle } from "./automation-pco-items.js";
import { PREFERRED_METRICS } from "./spl-recorder.js";
import { planTimeDueIn } from "./automation-plan-times.js";
import type { PlanTimeDTO } from "../types/stage.js";

type Live = {
  mode?: string;
  currentItemTitle?: string | null;
  serviceTimeStartsAt?: string | null;
  serverNow?: string;
  itemSchedule?: { title: string; dueAt: string }[];
};
type People = { total?: { attendance?: number | null; occupancy?: number | null } | null };
type Rec = { connected?: boolean; recording?: boolean };

const asLive = (v: unknown): Live => (v && typeof v === "object" ? (v as Live) : {});
const asRec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const metricOf = (v: unknown, metric: string): number | null => {
  const t = (v && typeof v === "object" ? (v as People).total : null) ?? null;
  const n = t ? (metric === "occupancy" ? t.occupancy : t.attendance) : null;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const METRIC: ParamDef = {
  key: "metric",
  label: "Metric",
  type: "enum",
  options: [
    { value: "attendance", label: "Attendance (entered)" },
    { value: "occupancy", label: "Occupancy (in room)" },
  ],
};

function def(t: TriggerDef): TriggerDef {
  return t;
}

/** Live states arrive as an array on "integrations:state-changed". */
type IntState = { id?: string; connection?: string };
const asStates = (v: unknown): IntState[] => (Array.isArray(v) ? (v as IntState[]) : []);
const connOf = (v: unknown, id: string): string | null =>
  asStates(v).find((s) => s.id === id)?.connection ?? null;

/** One label per integration, so a rule reads "OBS connects" rather than an id.
 *  Exported so the conditions read the same list and the two cannot diverge. */
export const INTEGRATIONS: { id: string; label: string }[] = [
  { id: "companion", label: "Companion" },
  { id: "obs", label: "OBS" },
  { id: "osc", label: "OSC" },
  { id: "planning-center", label: "Planning Center" },
  { id: "prodcom", label: "ProdCom" },
  { id: "propresenter", label: "ProPresenter" },
  { id: "pvp", label: "ProVideoPlayer" },
  { id: "reaper", label: "REAPER" },
  { id: "resi", label: "Resi" },
  { id: "ross-tsl", label: "Ross TSL" },
  { id: "rosstalk", label: "RossTalk" },
  { id: "sensource", label: "SenSource" },
  { id: "smaart", label: "Smaart" },
  { id: "youtube", label: "YouTube" },
  { id: "wireless", label: "Wireless" },
];

/** Connect/disconnect pair for one integration. Generated rather than written out
 *  once per integration, because the entries are mechanically identical — only the
 *  label differs, and that comes from the list above. */
function connectionTriggers(id: string, label: string): Record<string, TriggerDef> {
  return {
    [`${id}.connected`]: def({
      id: `${id}.connected`,
      label: `${label} connects`,
      channel: "integrations:state-changed",
      params: [],
      didFire: (prev, next) => {
        if (prev === null) return false;
        return connOf(prev, id) !== "connected" && connOf(next, id) === "connected";
      },
    }),
    [`${id}.disconnected`]: def({
      id: `${id}.disconnected`,
      label: `${label} disconnects`,
      channel: "integrations:state-changed",
      params: [],
      help: "Fires when the link drops, including into an error state.",
      didFire: (prev, next) => {
        if (prev === null) return false;
        const after = connOf(next, id);
        // A missing entry is UNKNOWN, not disconnected — an integration that
        // vanished from the payload must not read as a device going down.
        if (after === null) return false;
        return connOf(prev, id) === "connected" && after !== "connected";
      },
    }),
  };
}

type Obs = { connected?: boolean; recording?: boolean; streaming?: boolean; virtualCam?: boolean };
const asObs = (v: unknown): Obs => (v && typeof v === "object" ? (v as Obs) : {});

/**
 * Start/stop pair for one boolean OBS output (streaming, virtual cam).
 *
 * The stop half deliberately refuses to fire when OBS has gone unreachable: a
 * dropped connection reports every output as false, and treating that as "stopped"
 * would fire a stop rule because a machine went offline. Unknown is not a value.
 */
function obsOutputTriggers(
  key: "streaming" | "virtualCam",
  slug: string,
  label: string,
): Record<string, TriggerDef> {
  return {
    [`obs.${slug}-started`]: def({
      id: `obs.${slug}-started`,
      label: `OBS starts ${label}`,
      channel: "obs:status",
      params: [],
      didFire: (prev, next) => {
        if (prev === null) return false;
        return asObs(prev)[key] !== true && asObs(next)[key] === true;
      },
    }),
    [`obs.${slug}-stopped`]: def({
      id: `obs.${slug}-stopped`,
      label: `OBS stops ${label}`,
      channel: "obs:status",
      params: [],
      help: "Does not fire when OBS simply goes offline — unreachable is unknown, not stopped.",
      didFire: (prev, next) => {
        if (prev === null) return false;
        const n = asObs(next);
        if (n.connected === false) return false;
        return asObs(prev)[key] === true && n[key] === false;
      },
    }),
  };
}

/**
 * Went-live / went-offline for one streaming platform.
 *
 * Same shape and the same refusal as the OBS output pair: a platform that has
 * gone unreachable reports `live: false`, and treating that as "the stream
 * stopped" would fire a stop rule because an API call timed out. On a Sunday
 * that could kill a recording or drop a scene while the service is still going
 * out. Unknown is not a value.
 */
function streamTriggers(platform: string, channel: string, label: string): Record<string, TriggerDef> {
  const asStream = (v: unknown) => (v ?? {}) as { connected?: boolean; live?: boolean };
  return {
    [`${platform}.went-live`]: def({
      id: `${platform}.went-live`,
      label: `${label} goes live`,
      channel,
      params: [],
      didFire: (prev, next) => {
        if (prev === null) return false;
        return asStream(prev).live !== true && asStream(next).live === true;
      },
    }),
    [`${platform}.went-offline`]: def({
      id: `${platform}.went-offline`,
      label: `${label} stops streaming`,
      channel,
      params: [],
      help: `Does not fire when ${label} simply becomes unreachable — unreachable is unknown, not stopped.`,
      didFire: (prev, next) => {
        if (prev === null) return false;
        const n = asStream(next);
        if (n.connected === false) return false;
        return asStream(prev).live === true && n.live === false;
      },
    }),
  };
}

type Line = { id?: string; text?: string; channelName?: string | null };
const asLines = (v: unknown): Line[] => (Array.isArray(v) ? (v as Line[]) : []);

type Baptism = { phase?: string };
const asBaptism = (v: unknown): Baptism => (v && typeof v === "object" ? (v as Baptism) : {});

const asConnected = (v: unknown): string[] => {
  const c = v && typeof v === "object" ? (v as { connected?: unknown }).connected : null;
  return Array.isArray(c) ? (c as string[]) : [];
};

/**
 * One meter's current level, or null when absent.
 *
 * `spl:metrics` keys meters "device::channel" and each carries a `metrics` map
 * named exactly as Smaart names them — there is no single "level" field, so a
 * rule either names the metric or gets the same preference order the recorder
 * uses when it picks one for a recording.
 */
function splLevel(v: unknown, meter: string, metric: string): number | null {
  const meters = (v && typeof v === "object" ? (v as { meters?: unknown }).meters : null) ?? null;
  if (!meters || typeof meters !== "object") return null;
  const m = (meters as Record<string, { metrics?: unknown }>)[meter];
  const values = m?.metrics;
  if (!values || typeof values !== "object") return null;
  const map = values as Record<string, unknown>;
  const key = metric || PREFERRED_METRICS.find((k) => k in map) || Object.keys(map)[0];
  const n = key ? map[key] : undefined;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Threshold crossing in one direction, sharing the "no baseline, no crossing" rule. */
function splCrossed(
  prev: unknown,
  next: unknown,
  params: Record<string, unknown>,
  dir: "above" | "below",
): boolean {
  const meter = String(params.meter ?? "").trim();
  const metric = String(params.metric ?? "").trim();
  const a = splLevel(prev, meter, metric);
  const b = splLevel(next, meter, metric);
  if (a === null || b === null) return false; // no baseline, no crossing
  const th = Number(params.threshold);
  if (!Number.isFinite(th)) return false;
  return dir === "above" ? a <= th && b > th : a >= th && b < th;
}

/** slots:devices broadcasts Record<slotId, DeviceStatus>; the label a rule names
 *  is the device's own `name`, and a reading is null when the pack is offline. */
type Dev = { name?: string | null; battery?: unknown; rfBars?: unknown };
const asDevices = (v: unknown): Dev[] =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.values(v as Record<string, Dev>) : [];

/** Readings by device name for the watched slot (all slots when `slot` is blank).
 *  A pack with no reading is omitted entirely: unknown is not a low value. */
function deviceReadings(v: unknown, slot: string, field: "battery" | "rfBars"): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of asDevices(v)) {
    const name = (d?.name ?? "").trim();
    if (!name) continue;
    if (slot && name !== slot) continue;
    const n = d[field];
    if (typeof n === "number" && Number.isFinite(n)) out.set(name, n);
  }
  return out;
}

/** Crossed downward for any watched pack present on BOTH sides. */
function deviceCrossedBelow(
  prev: unknown,
  next: unknown,
  slot: string,
  field: "battery" | "rfBars",
  th: number,
): boolean {
  if (!Number.isFinite(th)) return false;
  const before = deviceReadings(prev, slot, field);
  for (const [name, b] of deviceReadings(next, slot, field)) {
    const a = before.get(name);
    if (a === undefined) continue; // no baseline for this pack
    if (a >= th && b < th) return true;
  }
  return false;
}

/**
 * Cumulative minutes over plan across FINISHED counted items.
 *
 * The timeline record carries no pre-computed drift, so this derives it the way
 * the History tab does: only items that have ended contribute, and pre-service
 * padding is excluded (a per-item `counted` override wins, else `preService`).
 */
function overrunMinutes(v: unknown): number | null {
  const items = (v && typeof v === "object" ? (v as { items?: unknown }).items : null) ?? null;
  if (!Array.isArray(items)) return null;
  let sec = 0;
  for (const raw of items as Record<string, unknown>[]) {
    const counted = typeof raw.counted === "boolean" ? raw.counted : raw.preService !== true;
    if (!counted) continue;
    if (raw.endedAt == null) continue; // still running — not yet a known overrun
    const actual = raw.actualDurationSec;
    const planned = raw.plannedLengthSec;
    if (typeof actual !== "number" || !Number.isFinite(actual)) continue;
    // An item PCO gave no planned length reads as neutral rather than as overrun.
    if (typeof planned !== "number" || !Number.isFinite(planned)) continue;
    sec += actual - planned;
  }
  return sec / 60;
}

/** The plan's rehearsal + service times off a live payload. */
function planTimesOf(v: unknown): PlanTimeDTO[] {
  const p = v && typeof v === "object" ? (v as { planTimes?: unknown }).planTimes : null;
  return Array.isArray(p) ? (p as PlanTimeDTO[]) : [];
}

const DISPLAY_NAME: ParamDef = {
  key: "name",
  label: "Display",
  type: "string",
  optional: true,
  optionsFrom: "displays",
  help: "Leave blank for any.",
};

export const AUTOMATION_TRIGGERS: Record<string, TriggerDef> = {
  ...Object.assign({}, ...INTEGRATIONS.map((i) => connectionTriggers(i.id, i.label))),
  ...obsOutputTriggers("streaming", "streaming", "streaming"),
  ...obsOutputTriggers("virtualCam", "virtualcam", "the virtual camera"),

  ...streamTriggers("resi", "resi:status", "Resi"),
  ...streamTriggers("youtube", "youtube:status", "YouTube"),

  "pco.before-plan-time": def({
    id: "pco.before-plan-time",
    label: "Before a rehearsal or service",
    channel: "pco:live",
    params: [
      {
        key: "minutes",
        label: "Minutes before",
        type: "number",
        min: 1,
        max: 1440,
        help: "Keep this inside the reconnect lead time (Advanced) or the gear may still be off.",
      },
      {
        key: "timeTypes",
        label: "Applies to",
        type: "multi-enum",
        options: [
          { value: "rehearsal", label: "Rehearsal" },
          { value: "service", label: "Service" },
        ],
      },
    ],
    help:
      "Fires before EVERY matching time on the plan, so a roster change after rehearsal still takes effect before the service.",
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const from = Date.parse(asLive(prev).serverNow ?? "");
      const to = Date.parse(asLive(next).serverNow ?? "");
      const raw = String(params.timeTypes ?? "").trim();
      // Unconfigured means both, matching how the other multi-enum params read.
      const types = raw ? raw.split(",").map((t) => t.trim()) : ["rehearsal", "service"];
      return planTimeDueIn(planTimesOf(next), from, to, Number(params.minutes), types) !== null;
    },
  }),

  "prodcom.phrase-said": def({
    id: "prodcom.phrase-said",
    label: "A phrase is said on ProdCom",
    channel: "prodcom:transcript",
    params: [
      { key: "phrase", label: "Phrase", type: "string", help: "Case-insensitive, matches part of a line." },
      { key: "channel", label: "On channel", type: "string", optional: true, help: "Leave blank for any channel." },
    ],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const want = String(params.phrase ?? "").trim().toLowerCase();
      if (!want) return false; // an empty phrase would match every line
      const onlyChannel = String(params.channel ?? "").trim().toLowerCase();

      // Only lines NOT already present: the transcript grows, so matching the
      // whole feed would fire on every broadcast for the rest of the service.
      const seen = new Set(asLines(prev).map((l) => l.id));
      return asLines(next).some((l) => {
        if (seen.has(l.id)) return false;
        if (onlyChannel && (l.channelName ?? "").trim().toLowerCase() !== onlyChannel) return false;
        return (l.text ?? "").toLowerCase().includes(want);
      });
    },
  }),

  "baptism.started": def({
    id: "baptism.started",
    label: "Baptism timer starts",
    channel: "baptism:state",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asBaptism(prev).phase === "idle" && asBaptism(next).phase !== "idle";
    },
  }),

  "baptism.phase-changed": def({
    id: "baptism.phase-changed",
    label: "Baptism moves to another phase",
    channel: "baptism:state",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      const a = asBaptism(prev).phase;
      const b = asBaptism(next).phase;
      return a !== undefined && b !== undefined && a !== b;
    },
  }),

  "baptism.finished": def({
    id: "baptism.finished",
    label: "Baptism timer finishes",
    channel: "baptism:state",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asBaptism(prev).phase !== "idle" && asBaptism(next).phase === "idle";
    },
  }),

  "display.connected": def({
    id: "display.connected",
    label: "A display connects",
    channel: "displays:presence",
    params: [DISPLAY_NAME],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const want = String(params.name ?? "").trim();
      const before = new Set(asConnected(prev));
      const arrived = asConnected(next).filter((d) => !before.has(d));
      return want ? arrived.includes(want) : arrived.length > 0;
    },
  }),

  "display.disconnected": def({
    id: "display.disconnected",
    label: "A display disconnects",
    channel: "displays:presence",
    params: [DISPLAY_NAME],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const want = String(params.name ?? "").trim();
      const after = new Set(asConnected(next));
      const left = asConnected(prev).filter((d) => !after.has(d));
      return want ? left.includes(want) : left.length > 0;
    },
  }),

  "spl.crossed-above": def({
    id: "spl.crossed-above",
    label: "SPL rises above",
    channel: "spl:metrics",
    params: [
      { key: "meter", label: "Meter", type: "string", help: 'The Smaart meter key, "device::channel".' },
      { key: "threshold", label: "Threshold (dB)", type: "number", min: 0, max: 140 },
      { key: "metric", label: "Metric", type: "string", optional: true, help: 'e.g. "SPL A Slow". Blank picks the usual one.' },
    ],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      return splCrossed(prev, next, params, "above");
    },
  }),

  "spl.crossed-below": def({
    id: "spl.crossed-below",
    label: "SPL falls below",
    channel: "spl:metrics",
    params: [
      { key: "meter", label: "Meter", type: "string", help: 'The Smaart meter key, "device::channel".' },
      { key: "threshold", label: "Threshold (dB)", type: "number", min: 0, max: 140 },
      { key: "metric", label: "Metric", type: "string", optional: true, help: 'e.g. "SPL A Slow". Blank picks the usual one.' },
    ],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      return splCrossed(prev, next, params, "below");
    },
  }),

  "wireless.battery-below": def({
    id: "wireless.battery-below",
    label: "A pack's battery falls below",
    channel: "slots:devices",
    params: [
      { key: "threshold", label: "Battery (%)", type: "number", min: 0, max: 100 },
      { key: "slot", label: "Mic", type: "string", optional: true, help: "The mic's name. Leave blank for any." },
    ],
    help: "A pack going offline does not fire this — a missing reading is unknown, not low.",
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      return deviceCrossedBelow(prev, next, String(params.slot ?? "").trim(), "battery", Number(params.threshold));
    },
  }),

  "wireless.rf-below": def({
    id: "wireless.rf-below",
    label: "A pack's RF falls below",
    channel: "slots:devices",
    params: [
      { key: "threshold", label: "RF bars", type: "number", min: 0, max: 5 },
      { key: "slot", label: "Mic", type: "string", optional: true, help: "The mic's name. Leave blank for any." },
    ],
    help: "A pack going offline does not fire this — a missing reading is unknown, not low.",
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      return deviceCrossedBelow(prev, next, String(params.slot ?? "").trim(), "rfBars", Number(params.threshold));
    },
  }),

  "service.running-over": def({
    id: "service.running-over",
    label: "The service runs over plan by",
    channel: "service-timeline:history",
    params: [{ key: "minutes", label: "Minutes over", type: "number", min: 1, max: 120 }],
    help: "Measured across finished items, so it is checked as each item ends.",
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const th = Number(params.minutes);
      if (!Number.isFinite(th)) return false;
      const a = overrunMinutes(prev);
      const b = overrunMinutes(next);
      if (a === null || b === null) return false;
      return a <= th && b > th;
    },
  }),

  "update.available": def({
    id: "update.available",
    label: "An update becomes available",
    channel: "update:status",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      const n = (v: unknown) => {
        const x = v && typeof v === "object" ? (v as { releasesBehind?: unknown }).releasesBehind : null;
        return typeof x === "number" && Number.isFinite(x) ? x : 0;
      };
      return n(prev) === 0 && n(next) > 0;
    },
  }),

  "display.none-connected": def({
    id: "display.none-connected",
    label: "Every display has disconnected",
    channel: "displays:presence",
    params: [],
    help: "Fires once when the last display drops off, not repeatedly while none are connected.",
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asConnected(prev).length > 0 && asConnected(next).length === 0;
    },
  }),

  "pco.service-started": def({
    id: "pco.service-started",
    label: "Service goes live",
    channel: "pco:live",
    params: [],
    help: "Fires the moment PCO Live moves from pre-service into the plan.",
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asLive(prev).mode !== "item" && asLive(next).mode === "item";
    },
  }),

  "pco.service-ended": def({
    id: "pco.service-ended",
    label: "Service ends",
    channel: "pco:live",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asLive(prev).mode === "item" && asLive(next).mode !== "item";
    },
  }),

  "pco.item-reached": def({
    id: "pco.item-reached",
    label: "Plan reaches an item",
    channel: "pco:live",
    params: [{ key: "title", label: "Item title contains", type: "string", help: "Case-insensitive, matches part of the title" }],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const want = String(params.title ?? "").trim().toLowerCase();
      if (!want) return false;
      const before = (asLive(prev).currentItemTitle ?? "").toLowerCase();
      const after = (asLive(next).currentItemTitle ?? "").toLowerCase();
      // Fire on the transition INTO a matching item, not while sitting on it.
      return !before.includes(want) && after.includes(want);
    },
  }),

  "pco.item-due": def({
    id: "pco.item-due",
    label: "Plan item is due",
    channel: "pco:live",
    params: [
      {
        key: "title",
        label: "Item",
        type: "string",
        optionsFrom: "plan-items",
        help: "Case-insensitive, matches part of the title. Renaming the item in PCO stops the rule.",
      },
      {
        key: "anchor",
        label: "Relative to",
        type: "enum",
        options: [
          { value: "item", label: "The item's own time" },
          { value: "service-start", label: "The service start" },
        ],
      },
      {
        key: "offsetMinutes",
        label: "Offset (minutes)",
        type: "number",
        min: -720,
        max: 720,
        help: "Negative fires before, positive after.",
      },
    ],
    help:
      "Fires once, when the chosen moment passes. An item is exact if a plan time is named after it; otherwise its time is estimated from item lengths and drifts if the service runs long.",
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const before = asLive(prev);
      const after = asLive(next);

      // THE EDGE IS IN TIME, not in the payload — nothing about the live state
      // changes when an item falls due. serverNow is the clock the payload was
      // built against, and consecutive snapshots' windows are contiguous by
      // construction, so the due moment lands in exactly one of them: fires once,
      // and never twice, with no state kept here. Using the engine's own `now` as
      // the upper bound instead would overlap successive windows and double-fire.
      const from = Date.parse(before.serverNow ?? "");
      const to = Date.parse(after.serverNow ?? "");
      if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return false;

      const item = findItemByTitle(after.itemSchedule ?? [], String(params.title ?? ""));
      if (!item) return false; // unknown item: never guess at a moment to fire

      const due = dueAt({
        anchor: params.anchor === "service-start" ? "service-start" : "item",
        itemTimeIso: item.dueAt,
        serviceStartIso: after.serviceTimeStartsAt ?? null,
        offsetMinutes: Number(params.offsetMinutes) || 0,
      });
      if (due === null) return false;

      return due > from && due <= to;
    },
  }),

  "occupancy.crossed-above": def({
    id: "occupancy.crossed-above",
    label: "People count rises above",
    channel: "people:count",
    params: [{ key: "threshold", label: "Threshold", type: "number", min: 0, max: 100000 }, METRIC],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const metric = String(params.metric ?? "attendance");
      const a = metricOf(prev, metric);
      const b = metricOf(next, metric);
      if (a === null || b === null) return false; // no baseline, no crossing
      const th = Number(params.threshold);
      return Number.isFinite(th) && a <= th && b > th;
    },
  }),

  "occupancy.crossed-below": def({
    id: "occupancy.crossed-below",
    label: "People count falls below",
    channel: "people:count",
    params: [{ key: "threshold", label: "Threshold", type: "number", min: 0, max: 100000 }, METRIC],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const metric = String(params.metric ?? "attendance");
      const a = metricOf(prev, metric);
      const b = metricOf(next, metric);
      if (a === null || b === null) return false;
      const th = Number(params.threshold);
      return Number.isFinite(th) && a >= th && b < th;
    },
  }),

  "recording.started": def({
    id: "recording.started",
    label: "Recording starts",
    channel: "obs:status",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      return !asRec(prev).recording && asRec(next).recording === true;
    },
  }),

  "recording.stopped": def({
    id: "recording.stopped",
    label: "Recording stops",
    channel: "obs:status",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      const p = asRec(prev);
      const n = asRec(next);
      // A recorder dropping off the network is UNKNOWN, not "stopped" — firing a
      // stop rule because a machine went offline would be wrong.
      if (n.connected === false) return false;
      return p.recording === true && n.recording === false;
    },
  }),
};

export function triggersForChannel(channel: string): TriggerDef[] {
  return Object.values(AUTOMATION_TRIGGERS).filter((t) => t.channel === channel);
}
